import { NextResponse } from "next/server";
import { headers } from "next/headers";
import Stripe from "stripe";
import { getPrimaryCustomerId } from "@/lib/stripe-customers";

// Initialize Stripe with your secret key
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: "2025-02-24.acacia"
});

// The correct transfer group ID
const ACCOUNT_GROUP_ID = "default";

// The payments pricing group ID - this is used for connected accounts
const PAYMENTS_PRICING_GROUP_ID = "acctgrp_S38FZGJsPr1nRk";

// Function to create transfers to connected accounts
async function createTransfersToConnectedAccounts(
  chargeId: string,
  connectedAccountIds: string[],
  amount: number,
  currency: string
) {
  if (connectedAccountIds.length === 0) {
    console.log("No connected account IDs provided for transfers");
    return;
  }

  console.log(
    `Creating transfers for charge ${chargeId} to ${connectedAccountIds.length} connected accounts`
  );

  try {
    // First, try to get the session that created this charge to get line items
    const paymentIntent = await stripe.paymentIntents.retrieve(
      chargeId.startsWith("ch_")
        ? ((
            await stripe.charges.retrieve(chargeId)
          ).payment_intent as string)
        : chargeId,
      {
        expand: ["transfer", "application_fee"]
      }
    );

    // If this payment intent already has a transfer, it means it was created with transfer_data
    // and the application_fee_amount, so we don't need to create a separate transfer
    if (paymentIntent.transfer) {
      console.log(
        `Payment intent ${paymentIntent.id} already has a transfer: ${paymentIntent.transfer.id}`
      );
      return;
    }

    // Get the checkout session from the payment intent
    const sessions = await stripe.checkout.sessions.list({
      payment_intent: paymentIntent.id,
      limit: 1,
      expand: ["data.line_items", "data.line_items.data.price.product"]
    });

    if (sessions.data.length > 0) {
      const session = sessions.data[0];

      // Check if this is a multi-vendor checkout
      const isMultiVendor = session.metadata?.is_multi_vendor === "true";

      if (isMultiVendor) {
        console.log(
          "This is part of a multi-vendor checkout - transfers are handled via application fees"
        );
        return;
      }

      // Get product-specific connected account mappings if available
      const productConnectedAccounts = session.metadata
        ?.product_connected_accounts
        ? session.metadata.product_connected_accounts
            .split(",")
            .reduce((acc: Record<string, string>, item: string) => {
              const [productId, accountId] = item.split(":");
              if (productId && accountId) {
                acc[productId] = accountId;
              }
              return acc;
            }, {})
        : {};

      // Get line items with their connected accounts
      const lineItems =
        session.line_items?.data
          .map((item) => {
            const product = item.price?.product as Stripe.Product;
            const productId = product?.id;

            return {
              productId,
              amount: item.amount_subtotal,
              quantity: item.quantity,
              connectedAccountId:
                productConnectedAccounts[productId] ||
                product?.metadata?.stripeConnectedAccountId
            };
          })
          .filter(
            (item) =>
              item.connectedAccountId &&
              connectedAccountIds.includes(item.connectedAccountId)
          ) || [];

      if (lineItems.length > 0) {
        console.log(
          "Processing line items with connected accounts:",
          lineItems
        );

        // Group by connected account ID
        const accountAmounts: Record<string, number> = {};

        // Calculate total amount per connected account
        for (const item of lineItems) {
          if (item.connectedAccountId) {
            accountAmounts[item.connectedAccountId] =
              (accountAmounts[item.connectedAccountId] || 0) + item.amount;
          }
        }

        // Create transfers for each account
        for (const [accountId, accountAmount] of Object.entries(
          accountAmounts
        )) {
          try {
            // Check if a transfer already exists
            const existingTransfers = await stripe.transfers.list({
              destination: accountId,
              transfer_group: ACCOUNT_GROUP_ID,
              limit: 10
            });

            if (
              existingTransfers.data.some(
                (t) => t.source_transaction === chargeId
              )
            ) {
              console.log(
                `Transfer already exists for charge ${chargeId} to account ${accountId}`
              );
              continue;
            }

            // Calculate fee (10%)
            const platformFee = Math.floor(accountAmount * 0.1);
            const transferAmount = accountAmount - platformFee;

            console.log(
              `Creating transfer to ${accountId} for ${transferAmount} ${currency} (original: ${accountAmount}, fee: ${platformFee})`
            );

            // Get the connected account to check its default currency
            const connectedAccount = await stripe.accounts.retrieve(accountId);
            const accountDefaultCurrency =
              connectedAccount.default_currency || currency;

            // Create the transfer with automatic currency conversion
            const transfer = await stripe.transfers.create({
              amount: transferAmount,
              currency: currency,
              destination: accountId,
              source_transaction: chargeId,
              description: `Transfer for charge ${chargeId}`,
              transfer_group: ACCOUNT_GROUP_ID,
              metadata: {
                original_currency: currency,
                account_currency: accountDefaultCurrency,
                automatic_conversion:
                  currency !== accountDefaultCurrency ? "true" : "false"
              }
            });

            console.log("Transfer created successfully:", transfer.id);
          } catch (error) {
            console.error(`Error creating transfer to ${accountId}:`, error);
          }
        }

        return;
      }
    }

    // Fallback to the original logic if no line items found
    console.log("No line items found, using fallback logic");

    // Calculate fee percentage (10%)
    const feePercentage = 0.1;
    const platformFee = Math.floor(amount * feePercentage);
    const amountPerVendor = Math.floor(
      (amount - platformFee) / connectedAccountIds.length
    );

    console.log(
      `Total amount: ${amount}, Platform fee: ${platformFee}, Amount per vendor: ${amountPerVendor}`
    );

    for (const accountId of connectedAccountIds) {
      try {
        // Check if a transfer already exists for this charge and destination
        const existingTransfers = await stripe.transfers.list({
          destination: accountId,
          transfer_group: ACCOUNT_GROUP_ID,
          limit: 10
        });

        if (
          existingTransfers.data.some((t) => t.source_transaction === chargeId)
        ) {
          console.log(
            `Transfer already exists for charge ${chargeId} to account ${accountId}`
          );
          continue;
        }

        // Get the connected account to check its default currency
        const connectedAccount = await stripe.accounts.retrieve(accountId);
        const accountDefaultCurrency =
          connectedAccount.default_currency || currency;

        console.log(
          `Creating transfer to ${accountId} for ${amountPerVendor} ${currency} (account currency: ${accountDefaultCurrency})`
        );

        // Create the transfer with automatic currency conversion
        const transfer = await stripe.transfers.create({
          amount: amountPerVendor,
          currency: currency,
          destination: accountId,
          source_transaction: chargeId,
          description: `Transfer for charge ${chargeId}`,
          transfer_group: ACCOUNT_GROUP_ID,
          metadata: {
            original_currency: currency,
            account_currency: accountDefaultCurrency,
            automatic_conversion:
              currency !== accountDefaultCurrency ? "true" : "false"
          }
        });

        console.log("Transfer created successfully:", transfer.id);
      } catch (error) {
        console.error(`Error creating transfer to ${accountId}:`, error);
      }
    }
  } catch (error) {
    console.error("Error in createTransfersToConnectedAccounts:", error);
  }
}

// Function to handle multi-vendor checkout continuation
async function handleMultiVendorContinuation(session: Stripe.Checkout.Session) {
  try {
    // Check if this is a multi-vendor checkout
    if (session.metadata?.is_multi_vendor !== "true") {
      return;
    }

    const vendorCount = Number.parseInt(
      session.metadata?.vendor_count || "0",
      10
    );
    const currentVendorIndex = Number.parseInt(
      session.metadata?.current_vendor_index || "0",
      10
    );

    // If this is the last vendor, we're done
    if (currentVendorIndex >= vendorCount) {
      console.log("Multi-vendor checkout complete - all vendors processed");
      return;
    }

    // Get the next vendor from the metadata
    const connectedAccountIds =
      session.metadata?.connected_account_ids?.split(",") || [];
    const allVendorIds = session.metadata?.all_vendor_ids?.split(",") || [];

    // If we don't have all vendor IDs stored, we can't continue
    if (allVendorIds.length === 0) {
      console.log(
        "No vendor IDs found in metadata - cannot continue multi-vendor checkout"
      );
      return;
    }

    const nextVendorIndex = currentVendorIndex + 1;
    if (nextVendorIndex >= allVendorIds.length) {
      console.log("No more vendors to process");
      return;
    }

    const nextVendorId = allVendorIds[nextVendorIndex];

    // We would need to create the next checkout session here, but this requires
    // more context about the items for the next vendor, which we don't have in this webhook
    console.log(
      `Next vendor to process: ${nextVendorId} (index ${nextVendorIndex})`
    );

    // In a real implementation, you would either:
    // 1. Store all the necessary data in the session metadata
    // 2. Or make an API call to your backend to get the next vendor's items
    // 3. Or redirect the user to a page that handles the next vendor checkout
  } catch (error) {
    console.error("Error handling multi-vendor continuation:", error);
  }
}

export async function POST(req: Request) {
  console.log("Webhook received:", new Date().toISOString());

  const body = await req.text();
  const headersList = headers();
  const signature = headersList.get("stripe-signature");

  if (!signature) {
    console.error("Missing stripe-signature header");
    return NextResponse.json(
      { error: "Missing stripe-signature header" },
      { status: 400 }
    );
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET as string
    );
    console.log("Webhook event type:", event.type);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    console.error("Webhook signature verification failed:", errorMessage);
    return NextResponse.json(
      { error: `Webhook Error: ${errorMessage}` },
      { status: 400 }
    );
  }

  // Handle the checkout.session.completed event
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    console.log("Processing checkout session:", session.id);

    try {
      // If the session has a customer ID, get the primary customer ID
      if (session.customer) {
        const customerId =
          typeof session.customer === "string"
            ? session.customer
            : session.customer.id;

        const primaryCustomerId = await getPrimaryCustomerId(customerId);

        // If the primary customer ID is different, update the session metadata
        if (primaryCustomerId !== customerId) {
          console.log(
            `Updating session ${session.id} to use primary customer ${primaryCustomerId} instead of ${customerId}`
          );

          // Update the session metadata to include the primary customer ID
          await stripe.checkout.sessions.update(session.id, {
            metadata: {
              ...session.metadata,
              original_customer_id: customerId,
              primary_customer_id: primaryCustomerId
            }
          });
        }
      }

      // Check if this is a multi-vendor checkout
      const isMultiVendor = session.metadata?.is_multi_vendor === "true";

      if (isMultiVendor) {
        console.log("This is a multi-vendor checkout session");
        // Handle multi-vendor continuation
        await handleMultiVendorContinuation(session);
      }

      // Get the payment intent ID
      const paymentIntentId = session.payment_intent as string;
      if (!paymentIntentId) {
        console.error("No payment intent ID in session");
        return NextResponse.json({ received: true });
      }

      // Get the payment intent
      const paymentIntent = await stripe.paymentIntents.retrieve(
        paymentIntentId,
        {
          expand: ["transfer", "application_fee"]
        }
      );
      console.log("Payment intent retrieved:", paymentIntentId);

      // If this payment intent already has a transfer, it means it was created with transfer_data
      // and the application_fee_amount, so we don't need to create a separate transfer
      if (paymentIntent.transfer) {
        console.log(
          `Payment intent ${paymentIntent.id} already has a transfer: ${paymentIntent.transfer.id}`
        );
        return NextResponse.json({ received: true });
      }

      // Get the charge ID
      if (typeof paymentIntent.latest_charge !== "string") {
        console.error("No charge ID available in payment intent");
        return NextResponse.json({ received: true });
      }

      const chargeId = paymentIntent.latest_charge;
      console.log("Charge ID:", chargeId);

      // Get the charge details
      const charge = await stripe.charges.retrieve(chargeId);
      console.log("Charge amount:", charge.amount, charge.currency);

      // Check if the charge has the correct transfer group
      if (charge.transfer_group !== ACCOUNT_GROUP_ID) {
        console.log(
          `Updating charge ${chargeId} with transfer group ${ACCOUNT_GROUP_ID}`
        );
        await stripe.charges.update(chargeId, {
          transfer_group: ACCOUNT_GROUP_ID
        });
      }

      // Get connected account IDs from session metadata
      const connectedAccountIds =
        session.metadata?.connected_account_ids?.split(",").filter(Boolean) ||
        [];

      // Create transfers to connected accounts
      await createTransfersToConnectedAccounts(
        chargeId,
        connectedAccountIds,
        charge.amount,
        charge.currency
      );
    } catch (error) {
      console.error("Error processing checkout session:", error);
    }
  }

  // Handle the payment_intent.succeeded event
  if (event.type === "payment_intent.succeeded") {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    console.log("Processing successful payment intent:", paymentIntent.id);

    try {
      // If this payment intent already has a transfer, it means it was created with transfer_data
      // and the application_fee_amount, so we don't need to create a separate transfer
      if (paymentIntent.transfer) {
        console.log(
          `Payment intent ${paymentIntent.id} already has a transfer: ${paymentIntent.transfer.id}`
        );
        return NextResponse.json({ received: true });
      }

      // Get the charge ID
      if (typeof paymentIntent.latest_charge !== "string") {
        console.error("No charge ID available in payment intent");
        return NextResponse.json({ received: true });
      }

      const chargeId = paymentIntent.latest_charge;
      console.log("Charge ID:", chargeId);

      // Get the charge details
      const charge = await stripe.charges.retrieve(chargeId);
      console.log("Charge amount:", charge.amount, charge.currency);

      // Check if the charge has the correct transfer group
      if (charge.transfer_group !== ACCOUNT_GROUP_ID) {
        console.log(
          `Updating charge ${chargeId} with transfer group ${ACCOUNT_GROUP_ID}`
        );
        await stripe.charges.update(chargeId, {
          transfer_group: ACCOUNT_GROUP_ID
        });
      }

      // Get connected account IDs from payment intent metadata
      const connectedAccountIds =
        paymentIntent.metadata?.connected_account_ids
          ?.split(",")
          .filter(Boolean) || [];

      // Create transfers to connected accounts
      await createTransfersToConnectedAccounts(
        chargeId,
        connectedAccountIds,
        charge.amount,
        charge.currency
      );
    } catch (error) {
      console.error("Error processing payment intent:", error);
    }
  }

  // Handle the charge.succeeded event
  if (event.type === "charge.succeeded") {
    const charge = event.data.object as Stripe.Charge;
    console.log("Processing successful charge:", charge.id);

    // Only process charges with our transfer group
    if (charge.transfer_group === ACCOUNT_GROUP_ID) {
      try {
        // Get the payment intent
        if (!charge.payment_intent) {
          console.error("No payment intent ID in charge");
          return NextResponse.json({ received: true });
        }

        const paymentIntentId =
          typeof charge.payment_intent === "string"
            ? charge.payment_intent
            : charge.payment_intent.id;

        // Get the payment intent
        const paymentIntent = await stripe.paymentIntents.retrieve(
          paymentIntentId,
          {
            expand: ["transfer", "application_fee"]
          }
        );
        console.log("Payment intent retrieved:", paymentIntentId);

        // If this payment intent already has a transfer, it means it was created with transfer_data
        // and the application_fee_amount, so we don't need to create a separate transfer
        if (paymentIntent.transfer) {
          console.log(
            `Payment intent ${paymentIntent.id} already has a transfer: ${paymentIntent.transfer.id}`
          );
          return NextResponse.json({ received: true });
        }

        // Get connected account IDs from payment intent metadata
        const connectedAccountIds =
          paymentIntent.metadata?.connected_account_ids
            ?.split(",")
            .filter(Boolean) || [];

        // Create transfers to connected accounts
        await createTransfersToConnectedAccounts(
          charge.id,
          connectedAccountIds,
          charge.amount,
          charge.currency
        );
      } catch (error) {
        console.error("Error processing charge:", error);
      }
    } else {
      console.log(
        `Charge ${charge.id} has different transfer group: ${charge.transfer_group}`
      );
    }
  }

  return NextResponse.json({ received: true });
}
