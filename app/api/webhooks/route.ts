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
    console.error(`Webhook signature verification failed: ${errorMessage}`)
    return NextResponse.json({ error: errorMessage }, { status: 400 })
  }

  // Handle the event
  if (event.type === "payment_intent.succeeded") {
    const paymentIntent = event.data.object as Stripe.PaymentIntent

    // Check if we have transfer data in the metadata
    if (paymentIntent.metadata?.transfer_data) {
      try {
        const transferData = JSON.parse(paymentIntent.metadata.transfer_data) as Array<{
          amount: number
          destination: string
        }>

        console.log(`Processing ${transferData.length} transfers for payment ${paymentIntent.id}`)

        // First, retrieve the payment intent with expanded charges
        const paymentIntentWithCharges = await stripe.paymentIntents.retrieve(paymentIntent.id, { expand: ["charges"] })

        // Get the latest charge ID
        const chargeId = paymentIntentWithCharges.latest_charge as string

        if (!chargeId) {
          throw new Error(`No charge found for payment intent ${paymentIntent.id}`)
        }

        // Create transfers for each vendor
        for (const transfer of transferData) {
          try {
            const result = await stripe.transfers.create({
              amount: transfer.amount,
              currency: paymentIntent.currency,
              destination: transfer.destination,
              source_transaction: chargeId,
              description: `Transfer for payment ${paymentIntent.id}`,
            })

            console.log(`Created transfer ${result.id} to ${transfer.destination} for ${transfer.amount}`)
          } catch (transferError) {
            console.error(`Error creating transfer to ${transfer.destination}:`, transferError)
          }
        }
      } catch (parseError) {
        console.error(`Error parsing transfer data from metadata:`, parseError)
      }
    }
  }

  return NextResponse.json({ received: true })
}
