import { NextResponse } from "next/server"
import { headers } from "next/headers"
import Stripe from "stripe"

// Initialize Stripe with your secret key
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: "2025-02-24.acacia", // Use a recent stable version
})

// The account group ID you found
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

  // Handle the event
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

      // Check for connected account IDs in metadata
      const connectedAccountIds = session.metadata?.connected_account_ids?.split(",") || []

      if (connectedAccountIds.length > 0) {
        console.log("Found connected account IDs:", connectedAccountIds)

        // Get the charge ID
        if (typeof paymentIntent.latest_charge === "string") {
          const chargeId = paymentIntent.latest_charge
          console.log("Charge ID:", chargeId)

          // Get the charge to verify it exists and has funds available
          const charge = await stripe.charges.retrieve(chargeId)
          console.log("Charge amount:", charge.amount, charge.currency)

          // Calculate fee percentage (10%)
          const feePercentage = 0.1

          // Process each connected account
          for (const accountId of connectedAccountIds) {
            try {
              // Get product IDs and names from metadata
              const productIds = session.metadata?.product_ids?.split(",") || []
              const productNames = session.metadata?.product_names?.split(",") || []

              // Find products associated with this connected account
              // This is a simplified approach - in a real system, you'd have a more precise mapping
              const accountProducts = productIds.map((id, index) => ({
                id,
                name: productNames[index] || "Unknown product",
              }))

              if (accountProducts.length > 0) {
                // Calculate a simple amount (total divided by number of vendors)
                // In a real system, you'd calculate the exact amount for each vendor's products
                const totalAmount = charge.amount
                const vendorAmount = Math.floor((totalAmount * (1 - feePercentage)) / connectedAccountIds.length)

                console.log(`Creating transfer to ${accountId} for ${vendorAmount} ${charge.currency}`)

                // Create the transfer
                const transfer = await stripe.transfers.create({
                  amount: vendorAmount,
                  currency: charge.currency,
                  destination: accountId,
                  source_transaction: chargeId,
                  description: `Transfer for session ${session.id}`,
                  // Use the account group ID
                  transfer_group: ACCOUNT_GROUP_ID,
                })

                console.log("Transfer created:", transfer.id)
              }
            } catch (error) {
              console.error(`Error processing transfer to ${accountId}:`, error)
            }
          }
        } else {
          console.error("No charge ID available")
        }
      } else {
        console.log("No connected account IDs found in session metadata")
      }
    } catch (error) {
      console.error("Error processing webhook:", error)
    }
  }

  return NextResponse.json({ received: true })
}

