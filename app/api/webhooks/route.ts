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
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  console.log(`Processing successful payment intent: ${paymentIntent.id}`);

  if (!paymentIntent.metadata?.transfer_groups) {
    console.log("No transfer groups found in metadata");
    return NextResponse.json({ received: true });
  }

  try {
    const transferGroups = JSON.parse(paymentIntent.metadata.transfer_groups) as Record<
      string,
      { amount: number; application_fee: number }
    >;

    const chargeId = paymentIntent.latest_charge;
    if (!chargeId || typeof chargeId !== "string") {
      console.error("No valid charge ID found");
      return NextResponse.json({ error: "No charge ID found" }, { status: 400 });
    }

    // Procesează fiecare transfer
    for (const [accountId, { amount, application_fee }] of Object.entries(transferGroups)) {
      try {
        // 1. Creează transferul către vânzător
        const transfer = await stripe.transfers.create({
          amount,
          currency: paymentIntent.currency,
          destination: accountId,
          source_transaction: chargeId,
          transfer_group: paymentIntent.transfer_group || undefined,
          description: `Transfer for order ${paymentIntent.metadata?.user_id || 'unknown'}`,
        });

        console.log(`Created transfer ${transfer.id} to ${accountId} for ${amount}`);

        // 2. Creează application fee pentru platformă
        if (application_fee > 0) {
          const fee = await stripe.applicationFees.create({
            amount: application_fee,
            currency: paymentIntent.currency,
            originating_transaction: chargeId,
          });
          console.log(`Created application fee ${fee.id} for ${application_fee}`);
        }

      } catch (error) {
        console.error(`Failed processing for account ${accountId}:`, error);
        // Poți adăuga aici notificări sau retry logic
      }
    }

  } catch (error) {
    console.error("Error processing payment intent:", error);
    return NextResponse.json(
      { error: "Payment processing failed", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }

  return NextResponse.json({ received: true });
}
