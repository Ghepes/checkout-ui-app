import { NextResponse } from "next/server"
import { headers } from "next/headers"
import Stripe from "stripe"

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string)
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET as string

export async function POST(req: Request) {
  const body = await req.text()
  const headersList = await headers()
  const signature = headersList.get("stripe-signature")

  if (!signature) {
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 })
  }

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret)
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error"
    console.error("Webhook signature verification failed:", errorMessage)
    return NextResponse.json({ error: `Webhook Error: ${errorMessage}` }, { status: 400 })
  }

  // Handle the event
  switch (event.type) {
    case "checkout.session.completed":
      return await handleCheckoutSessionCompleted(event)
    case "payment_intent.succeeded":
      return await handlePaymentIntentSucceeded(event)
    default:
      console.log(`Unhandled event type: ${event.type}`)
      return NextResponse.json({ received: true })
  }
}

async function handleCheckoutSessionCompleted(event: Stripe.Event) {
  const session = event.data.object as Stripe.Checkout.Session

  if (session.payment_status !== "paid") {
    console.log(`Session ${session.id} not paid, skipping`)
    return NextResponse.json({ received: true })
  }

  console.log(`Processing paid session: ${session.id}`)

  // Send notification to dashboard if needed
  try {
    const dashboardWebhookUrl = process.env.DASHBOARD_WEBHOOK_URL
    if (dashboardWebhookUrl) {
      await fetch(dashboardWebhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.DASHBOARD_API_KEY}`,
        },
        body: JSON.stringify({
          user_id: session.metadata?.user_id,
          email: session.customer_email,
          product_ids: session.metadata?.product_ids,
          amount_total: session.amount_total,
          payment_status: session.payment_status,
          stripe_session_id: session.id,
          created_at: new Date().toISOString(),
        }),
      })
      console.log("Dashboard notification sent")
    }
  } catch (error) {
    console.error("Failed to notify dashboard:", error)
  }

  return NextResponse.json({ received: true })
}

async function handlePaymentIntentSucceeded(event: Stripe.Event) {
  const paymentIntent = event.data.object as Stripe.PaymentIntent
  console.log(`Processing successful payment intent: ${paymentIntent.id}`)

  // Check if we have transfer groups in metadata
  if (!paymentIntent.metadata?.transfer_groups) {
    console.log("No transfer groups found in metadata")
    return NextResponse.json({ received: true })
  }

  try {
    const transferGroups = JSON.parse(paymentIntent.metadata.transfer_groups) as Record<
      string,
      { amount: number; application_fee: number }
    >

    console.log(`Processing ${Object.keys(transferGroups).length} transfers for payment ${paymentIntent.id}`)

    // Get the charge ID
    const chargeId = paymentIntent.latest_charge
    if (!chargeId || typeof chargeId !== "string") {
      console.error("No valid charge ID found for payment intent")
      return NextResponse.json({ error: "No charge ID found" }, { status: 400 })
    }

    // Process transfers for each vendor
    const transferResults = await Promise.allSettled(
        Object.entries(transferGroups).map(async ([accountId, { amount }]) => {
          try {
            const transferParams: Stripe.TransferCreateParams = {
              amount,
              currency: paymentIntent.currency,
              destination: accountId,
              source_transaction: chargeId,
              description: `Transfer for order ${paymentIntent.metadata?.user_id || 'unknown'}`,
            }
  
            // Adaugă transfer_group doar dacă există
            if (paymentIntent.transfer_group) {
              transferParams.transfer_group = paymentIntent.transfer_group
            }
  
            const transfer = await stripe.transfers.create(transferParams)
            console.log(`Created transfer ${transfer.id} to ${accountId} for ${amount}`)
            return transfer
          } catch (error) {
            console.error(`Failed to create transfer to ${accountId}:`, error)
            throw error
          }
        })
      )
  
      const failedTransfers = transferResults.filter(r => r.status === 'rejected')
      if (failedTransfers.length > 0) {
        console.error(`${failedTransfers.length} transfers failed`)
        // Implementează logica de retry sau notificare aici
      }
  
    } catch (error) {
      console.error("Error processing transfers:", error)
      return NextResponse.json(
        { error: "Failed to process transfers", details: error instanceof Error ? error.message : "Unknown error" },
        { status: 500 }
      )
    }
  
    return NextResponse.json({ received: true })
  }