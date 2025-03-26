import { NextResponse } from "next/server"
import { headers } from "next/headers"
import Stripe from "stripe"

// Initialize Stripe with your secret key
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
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session

    // Verify the payment status
    if (session.payment_status === "paid") {
      console.log(`Processing paid session: ${session.id}`)

      // Get the payment intent ID from the session
      const paymentIntentId = session.payment_intent as string

      if (!paymentIntentId) {
        console.error("No payment intent ID found in session")
        return NextResponse.json({ error: "No payment intent ID found" }, { status: 400 })
      }

      // Retrieve the payment intent to get transfer data
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId)

      // Check if we have transfer data in the metadata
      if (paymentIntent.metadata?.transfer_data) {
        try {
          const transferData = JSON.parse(paymentIntent.metadata.transfer_data) as Array<{
            amount: number
            destination: string
          }>

          console.log(`Processing ${transferData.length} transfers for payment ${paymentIntentId}`)

          // Get the charge ID
          let chargeId: string | null = null

          if (typeof paymentIntent.latest_charge === "string") {
            chargeId = paymentIntent.latest_charge
            console.log(`Using charge ID: ${chargeId}`)

            // Create transfers for each vendor
            for (const transfer of transferData) {
              try {
                const result = await stripe.transfers.create({
                  amount: transfer.amount,
                  currency: paymentIntent.currency,
                  destination: transfer.destination,
                  source_transaction: chargeId,
                  description: `Transfer for payment ${paymentIntentId}`,
                })

                console.log(`Created transfer ${result.id} to ${transfer.destination} for ${transfer.amount}`)
              } catch (transferError) {
                console.error(`Error creating transfer to ${transfer.destination}:`, transferError)
              }
            }
          } else {
            console.error("No charge ID found for payment intent")
          }
        } catch (parseError) {
          console.error("Error parsing transfer data from metadata:", parseError)
        }
      } else {
        console.log("No transfer data found in payment intent metadata")
      }

      // Send the purchase data to the dashboard app if needed
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
              product_id: session.metadata?.product_id,
              product_name: session.metadata?.product_name,
              amount_total: session.amount_total,
              payment_status: session.payment_status,
              stripe_session_id: session.id,
              download_url: session.metadata?.productDev0,
              created_at: new Date().toISOString(),
            }),
          })
        }
      } catch (error) {
        console.error("Failed to notify dashboard:", error)
      }
    }
  }

  return NextResponse.json({ received: true })
}

