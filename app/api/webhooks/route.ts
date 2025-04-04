import { NextResponse } from "next/server"
import { headers } from "next/headers"
import Stripe from "stripe"

// Initialize Stripe with your secret key
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: "2025-02-24.acacia",
})

// The account group ID - updated to your actual account group
const ACCOUNT_GROUP_ID = "acctgrp_S38FZGJsPr1nRk"

// Function to create transfers to connected accounts
async function createTransfersToConnectedAccounts(
  chargeId: string,
  connectedAccountIds: string[],
  amount: number,
  currency: string,
) {
  if (connectedAccountIds.length === 0) {
    console.log("No connected account IDs provided for transfers")
    return
  }

  console.log(`Creating transfers for charge ${chargeId} to ${connectedAccountIds.length} connected accounts`)

  // Calculate fee percentage (10%)
  const feePercentage = 0.1
  const platformFee = Math.floor(amount * feePercentage)
  const amountPerVendor = Math.floor((amount - platformFee) / connectedAccountIds.length)

  console.log(`Total amount: ${amount}, Platform fee: ${platformFee}, Amount per vendor: ${amountPerVendor}`)

  for (const accountId of connectedAccountIds) {
    try {
      // Check if a transfer already exists for this charge and destination
      const existingTransfers = await stripe.transfers.list({
        destination: accountId,
        transfer_group: ACCOUNT_GROUP_ID,
        limit: 10,
      })

      if (existingTransfers.data.some((t) => t.source_transaction === chargeId)) {
        console.log(`Transfer already exists for charge ${chargeId} to account ${accountId}`)
        continue
      }

      console.log(`Creating transfer to ${accountId} for ${amountPerVendor} ${currency}`)

      const transfer = await stripe.transfers.create({
        amount: amountPerVendor,
        currency: currency,
        destination: accountId,
        source_transaction: chargeId,
        description: `Transfer for charge ${chargeId}`,
        transfer_group: ACCOUNT_GROUP_ID,
      })

      console.log("Transfer created successfully:", transfer.id)
    } catch (error) {
      console.error(`Error creating transfer to ${accountId}:`, error)
    }
  }
}

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

      // Create transfers to connected accounts
      await createTransfersToConnectedAccounts(chargeId, connectedAccountIds, charge.amount, charge.currency)
    } catch (error) {
      console.error("Error processing checkout session:", error)
    }
  }

  // Handle the payment_intent.succeeded event
  if (event.type === "payment_intent.succeeded") {
    const paymentIntent = event.data.object as Stripe.PaymentIntent
    console.log("Processing successful payment intent:", paymentIntent.id)

    try {
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

      // Get connected account IDs from payment intent metadata
      const connectedAccountIds = paymentIntent.metadata?.connected_account_ids?.split(",").filter(Boolean) || []

      // Create transfers to connected accounts
      await createTransfersToConnectedAccounts(chargeId, connectedAccountIds, charge.amount, charge.currency)
    } catch (error) {
      console.error("Error processing payment intent:", error)
    }
  }

  // Handle the charge.succeeded event
  if (event.type === "charge.succeeded") {
    const charge = event.data.object as Stripe.Charge
    console.log("Processing successful charge:", charge.id)

    // Only process charges with our transfer group
    if (charge.transfer_group === ACCOUNT_GROUP_ID) {
      try {
        // Get the payment intent
        if (!charge.payment_intent) {
          console.error("No payment intent ID in charge")
          return NextResponse.json({ received: true })
        }

        const paymentIntentId =
          typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent.id

        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId)
        console.log("Payment intent retrieved:", paymentIntentId)

        // Get connected account IDs from payment intent metadata
        const connectedAccountIds = paymentIntent.metadata?.connected_account_ids?.split(",").filter(Boolean) || []

        // If no connected account IDs in payment intent metadata, try to find the session
        if (connectedAccountIds.length === 0) {
          const sessions = await stripe.checkout.sessions.list({
            payment_intent: paymentIntentId,
            limit: 1,
          })

          if (sessions.data.length > 0) {
            const session = sessions.data[0]
            const sessionConnectedAccountIds = session.metadata?.connected_account_ids?.split(",").filter(Boolean) || []

            if (sessionConnectedAccountIds.length > 0) {
              console.log("Found connected account IDs in session:", sessionConnectedAccountIds)

              // Create transfers to connected accounts
              await createTransfersToConnectedAccounts(
                charge.id,
                sessionConnectedAccountIds,
                charge.amount,
                charge.currency,
              )

              return NextResponse.json({ received: true })
            }
          }
        }

        // Create transfers to connected accounts
        await createTransfersToConnectedAccounts(charge.id, connectedAccountIds, charge.amount, charge.currency)
      } catch (error) {
        console.error("Error processing charge:", error)
      }
    } else {
      console.log(`Charge ${charge.id} has different transfer group: ${charge.transfer_group}`)
    }
  }

  return NextResponse.json({ received: true })
}
