import { NextResponse } from "next/server"
import Stripe from "stripe"

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string)

interface CartItem {
  id: string
  priceId: string
  quantity: number
  stripeAccountId?: string | null
}

interface CheckoutRequest {
  items: CartItem[]
  userId: string
}

export async function POST(req: Request) {
  // Handle CORS preflight request
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "https://ui-app.com",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    })
  }

  try {
    const { items, userId }: CheckoutRequest = await req.json()

    if (!items || !items.length) {
      return NextResponse.json(
        { error: "Cart is empty" },
        {
          status: 400,
          headers: {
            "Access-Control-Allow-Origin": "https://ui-app.com",
          },
        },
      )
    }

    // Group items by Stripe account ID
    const itemsByAccount: Record<string, CartItem[]> = {}

    // Default group for items without a Stripe account ID
    itemsByAccount["platform"] = []

    // Group items by their Stripe account ID
    items.forEach((item) => {
      if (item.stripeAccountId) {
        if (!itemsByAccount[item.stripeAccountId]) {
          itemsByAccount[item.stripeAccountId] = []
        }
        itemsByAccount[item.stripeAccountId].push(item)
      } else {
        itemsByAccount["platform"].push(item)
      }
    })

    // If we only have platform items or items from a single account, create a single checkout session
    if (
      Object.keys(itemsByAccount).length === 1 ||
      (Object.keys(itemsByAccount).length === 2 && itemsByAccount["platform"].length === 0)
    ) {
      // Get the account ID (if any)
      const accountId = Object.keys(itemsByAccount).find((id) => id !== "platform")

      // Create the checkout session
      const session = await createCheckoutSession(items, userId, accountId !== "platform" ? accountId : undefined)

      return NextResponse.json(
        { url: session.url },
        {
          headers: {
            "Access-Control-Allow-Origin": "https://ui-app.com",
          },
        },
      )
    }
    // If we have items from multiple accounts, we need to handle this differently
    // This is a more complex scenario that might require a custom checkout flow
    else {
      // For simplicity, we'll just create a checkout for the platform items for now
      // In a real implementation, you'd need to handle this case more carefully
      const session = await createCheckoutSession(items, userId)

      return NextResponse.json(
        { url: session.url },
        {
          headers: {
            "Access-Control-Allow-Origin": "https://ui-app.com",
          },
        },
      )
    }
  } catch (error) {
    console.error("Checkout API error:", error)
    return NextResponse.json(
      { error: "Failed to create checkout session" },
      {
        status: 500,
        headers: {
          "Access-Control-Allow-Origin": "https://ui-app.com",
        },
      },
    )
  }
}

// Helper function to create a checkout session
async function createCheckoutSession(items: CartItem[], userId: string, stripeAccountId?: string) {
  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    payment_method_types: ["card"],
    mode: "payment",
    line_items: items.map((item: CartItem) => ({
      price: item.priceId,
      quantity: item.quantity,
    })),
    success_url: `https://ui-app.com/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `https://ui-app.com/cancel`,
    metadata: {
      user_id: userId,
      product_ids: items.map((item: CartItem) => item.id).join(","),
    },
  }

  // If we have a Stripe account ID, add it to the session params
  if (stripeAccountId) {
    // For direct charges
    sessionParams.payment_intent_data = {
      transfer_data: {
        destination: stripeAccountId,
      },
    }

    // Alternatively, for application fees (if you're taking a platform fee)
    // sessionParams.payment_intent_data = {
    //   application_fee_amount: calculateApplicationFee(items),
    //   transfer_data: {
    //     destination: stripeAccountId,
    //   },
    // };
  }

  return await stripe.checkout.sessions.create(sessionParams)
}

// Helper function to calculate application fees (if needed)
function calculateApplicationFee(items: CartItem[]): number {
  // Calculate the total amount
  const totalAmount = items.reduce((sum, item) => {
    // You'll need to get the price amount from somewhere
    // This is just a placeholder
    const priceAmount = 1000 // $10.00 in cents
    return sum + priceAmount * item.quantity
  }, 0)

  // Calculate the fee (e.g., 10%)
  return Math.round(totalAmount * 0.1)
}

