import { NextResponse } from "next/server"
import { headers } from "next/headers"
import Stripe from "stripe"

// Initialize Stripe with your secret key
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: "2025-02-24.acacia",
})

// The account group ID
const ACCOUNT_GROUP_ID = "acctgrp_ReaChY6ZbHKyvb"

export async function POST(req: Request) {
  console.log("Webhook received:", new Date().toISOString())

  const body = await req.text()
  const headersList = await headers()
  const signature = headersList.get("stripe-signature")

  if (!signature) {
    console.error("Missing stripe-signature header")
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 })
  }

  let event: Stripe.Event

  try {
    event = stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET as string)
    console.log("Webhook event type:", event.type)
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error"
    console.error("Webhook signature verification failed:", errorMessage)
    return NextResponse.json({ error: `Webhook Error: ${errorMessage}` }, { status: 400 })
  }

  // Handle the checkout.session.completed event
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session
    console.log("Processing checkout session:", session.id)

    try {
      // Get the payment intent ID
      const paymentIntentId = session.payment_intent as string
      if (!paymentIntentId) {
        console.error("No payment intent ID in session")
        return NextResponse.json({ received: true })
      }

      // Get the payment intent
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId)
      console.log("Payment intent retrieved:", paymentIntentId)

      // Get the charge ID
      if (typeof paymentIntent.latest_charge !== "string") {
        console.error("No charge ID available in payment intent")
        return NextResponse.json({ received: true })
      }

      const chargeId = paymentIntent.latest_charge
      console.log("Charge ID:", chargeId)

      // Get the charge details
      const charge = await stripe.charges.retrieve(chargeId)
      console.log("Charge amount:", charge.amount, charge.currency)

      // Check if the charge has the correct transfer group
      if (charge.transfer_group !== ACCOUNT_GROUP_ID) {
        console.log(`Updating charge ${chargeId} with transfer group ${ACCOUNT_GROUP_ID}`)
        await stripe.charges.update(chargeId, {
          transfer_group: ACCOUNT_GROUP_ID,
        })
      }

      // Get connected account IDs from session metadata
      const connectedAccountIds = session.metadata?.connected_account_ids?.split(",").filter(Boolean) || []

      if (connectedAccountIds.length === 0) {
        console.log("No connected account IDs found in session metadata")

        // Try to get vendor information from product metadata
        const productIds = session.metadata?.product_ids?.split(",") || []

        if (productIds.length > 0) {
          console.log("Attempting to find connected accounts from products:", productIds)

          for (const productId of productIds) {
            try {
              const product = await stripe.products.retrieve(productId)

              if (product.metadata?.stripeConnectedAccountId) {
                connectedAccountIds.push(product.metadata.stripeConnectedAccountId)
                console.log(
                  `Found connected account ${product.metadata.stripeConnectedAccountId} for product ${productId}`,
                )
              }
            } catch (error) {
              console.error(`Error retrieving product ${productId}:`, error)
            }
          }
        }
      }

      if (connectedAccountIds.length === 0) {
        console.log("No connected accounts found for this purchase")
        return NextResponse.json({ received: true })
      }

      console.log("Found connected account IDs:", connectedAccountIds)

      // Calculate fee percentage (10%)
      const feePercentage = 0.1

      // Calculate amount per vendor (equal split for simplicity)
      const totalAmount = charge.amount
      const platformFee = Math.floor(totalAmount * feePercentage)
      const amountPerVendor = Math.floor((totalAmount - platformFee) / connectedAccountIds.length)

      console.log(`Total amount: ${totalAmount}, Platform fee: ${platformFee}, Amount per vendor: ${amountPerVendor}`)

      // Create transfers to each connected account
      for (const accountId of connectedAccountIds) {
        try {
          console.log(`Creating transfer to ${accountId} for ${amountPerVendor} ${charge.currency}`)

          const transfer = await stripe.transfers.create({
            amount: amountPerVendor,
            currency: charge.currency,
            destination: accountId,
            source_transaction: chargeId,
            description: `Transfer for session ${session.id}`,
            transfer_group: ACCOUNT_GROUP_ID,
          })

          console.log("Transfer created successfully:", transfer.id)
        } catch (error) {
          console.error(`Error creating transfer to ${accountId}:`, error)
        }
      }
    } catch (error) {
      console.error("Error processing webhook:", error)
    }
  }

  // Also handle the charge.succeeded event as a backup
  if (event.type === "charge.succeeded") {
    const charge = event.data.object as Stripe.Charge
    console.log("Processing charge:", charge.id)

    // Only process charges with our transfer group
    if (charge.transfer_group === ACCOUNT_GROUP_ID) {
      try {
        // Look up the session by payment intent
        const sessions = await stripe.checkout.sessions.list({
          payment_intent: charge.payment_intent as string,
          limit: 1,
        })

        if (sessions.data.length === 0) {
          console.log("No session found for this charge")
          return NextResponse.json({ received: true })
        }

        const session = sessions.data[0]

        // Get connected account IDs from session metadata
        const connectedAccountIds = session.metadata?.connected_account_ids?.split(",").filter(Boolean) || []

        if (connectedAccountIds.length === 0) {
          console.log("No connected account IDs found in session metadata")
          return NextResponse.json({ received: true })
        }

        console.log("Found connected account IDs from charge event:", connectedAccountIds)

        // Calculate fee percentage (10%)
        const feePercentage = 0.1

        // Calculate amount per vendor (equal split for simplicity)
        const totalAmount = charge.amount
        const platformFee = Math.floor(totalAmount * feePercentage)
        const amountPerVendor = Math.floor((totalAmount - platformFee) / connectedAccountIds.length)

        console.log(`Total amount: ${totalAmount}, Platform fee: ${platformFee}, Amount per vendor: ${amountPerVendor}`)

        // Create transfers to each connected account
        for (const accountId of connectedAccountIds) {
          try {
            // Check if a transfer already exists for this charge and destination
            const existingTransfers = await stripe.transfers.list({
              destination: accountId,
              transfer_group: ACCOUNT_GROUP_ID,
            })

            if (existingTransfers.data.some((t) => t.source_transaction === charge.id)) {
              console.log(`Transfer already exists for charge ${charge.id} to account ${accountId}`)
              continue
            }

            console.log(`Creating transfer to ${accountId} for ${amountPerVendor} ${charge.currency}`)

            const transfer = await stripe.transfers.create({
              amount: amountPerVendor,
              currency: charge.currency,
              destination: accountId,
              source_transaction: charge.id,
              description: `Transfer for charge ${charge.id}`,
              transfer_group: ACCOUNT_GROUP_ID,
            })

            console.log("Transfer created successfully:", transfer.id)
          } catch (error) {
            console.error(`Error creating transfer to ${accountId}:`, error)
          }
        }
      } catch (error) {
        console.error("Error processing charge event:", error)
      }
    } else {
      console.log(`Charge ${charge.id} has different transfer group: ${charge.transfer_group}`)
    }
  }

  return NextResponse.json({ received: true })
}
