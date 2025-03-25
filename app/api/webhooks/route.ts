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
    console.error("Missing stripe-signature header")
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 })
  }

  let event: Stripe.Event

  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret)
    console.log(`Received webhook event: ${event.type}`)
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error"
    console.error(`Webhook signature verification failed: ${errorMessage}`)
    return NextResponse.json({ error: errorMessage }, { status: 400 })
  }

  // Handle the event
  if (event.type === "payment_intent.succeeded" || event.type === "checkout.session.completed") {
    try {
      let paymentIntentId: string

      // Extract payment intent ID based on event type
      if (event.type === "payment_intent.succeeded") {
        const paymentIntent = event.data.object as Stripe.PaymentIntent
        paymentIntentId = paymentIntent.id
        console.log(`Processing payment_intent.succeeded for ${paymentIntentId}`)
      } else {
        // For checkout.session.completed, get the payment intent ID from the session
        const session = event.data.object as Stripe.Checkout.Session
        paymentIntentId = session.payment_intent as string
        console.log(`Processing checkout.session.completed with payment intent ${paymentIntentId}`)
      }

      // Retrieve the payment intent with expanded charges
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["charges.data"] })

      console.log(`Payment intent status: ${paymentIntent.status}`)
      console.log(`Payment intent metadata: ${JSON.stringify(paymentIntent.metadata)}`)

      // Check if we have transfer data in the metadata
      if (paymentIntent.metadata?.transfer_data) {
        try {
          const transferData = JSON.parse(paymentIntent.metadata.transfer_data) as Array<{
            amount: number
            destination: string
          }>

          console.log(`Found transfer data for ${transferData.length} vendors`)

          // Get the charge ID
          let chargeId: string | null = null

          if (typeof paymentIntent.latest_charge === "string") {
            chargeId = paymentIntent.latest_charge
            console.log(`Using latest_charge: ${chargeId}`)
          } else if (paymentIntent.charges?.data && paymentIntent.charges.data.length > 0) {
            chargeId = paymentIntent.charges.data[0].id
            console.log(`Using first charge from charges.data: ${chargeId}`)
          }

          if (!chargeId) {
            throw new Error(`No charge found for payment intent ${paymentIntentId}`)
          }

          // Create transfers for each vendor
          for (const transfer of transferData) {
            try {
              console.log(
                `Creating transfer to ${transfer.destination} for ${transfer.amount} ${paymentIntent.currency}`,
              )

              const result = await stripe.transfers.create({
                amount: transfer.amount,
                currency: paymentIntent.currency,
                destination: transfer.destination,
                source_transaction: chargeId,
                description: `Transfer for payment ${paymentIntentId}`,
              })

              console.log(
                `✅ Successfully created transfer ${result.id} to ${transfer.destination} for ${transfer.amount}`,
              )
            } catch (transferError) {
              console.error(`❌ Error creating transfer to ${transfer.destination}:`, transferError)
            }
          }
        } catch (parseError) {
          console.error(`Error parsing transfer data from metadata:`, parseError)
        }
      } else {
        console.log(`No transfer_data found in payment intent metadata`)
      }
    } catch (error) {
      console.error(`Error processing webhook event:`, error)
    }
  }

  return NextResponse.json({ received: true })
}

