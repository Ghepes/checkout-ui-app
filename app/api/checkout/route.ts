import { NextResponse } from "next/server"
import Stripe from "stripe"

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string)

interface CartItem {
  id: string
  priceId: string
  quantity: number
  stripeConnectedAccountId?: string | null
  name?: string
  vendorName?: string
  vendorEmail?: string
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
        "Access-Control-Allow-Origin": "https://ui-app.com", // Allow requests from any origin
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    })
  }

  try {
    const { items, userId }: CheckoutRequest = await req.json()

    console.log("Checkout server received request:", { userId, itemCount: items.length })

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

    // Log the items with their Connected Account IDs
    console.log(
      "Items with Connected Account IDs:",
      items.map((item) => ({
        id: item.id,
        name: item.name,
        stripeConnectedAccountId: item.stripeConnectedAccountId || "none",
      })),
    )

    // Group items by Stripe account ID
    const itemsByAccount: Record<string, CartItem[]> = {}

    // Default group for items without a Stripe account ID
    itemsByAccount["platform"] = []

    // Group items by their Stripe Connected Account ID
    items.forEach((item) => {
      if (item.stripeConnectedAccountId) {
        if (!itemsByAccount[item.stripeConnectedAccountId]) {
          itemsByAccount[item.stripeConnectedAccountId] = []
        }
        itemsByAccount[item.stripeConnectedAccountId].push(item)
      } else {
        itemsByAccount["platform"].push(item)
      }
    })

    console.log("Items grouped by account:", Object.keys(itemsByAccount))

    // If we only have platform items or items from a single account, create a single checkout session
    if (
      Object.keys(itemsByAccount).length === 1 ||
      (Object.keys(itemsByAccount).length === 2 && itemsByAccount["platform"].length === 0)
    ) {
      // Get the account ID (if any)
      const accountId = Object.keys(itemsByAccount).find((id) => id !== "platform")

      console.log(`Creating single checkout session with account ID: ${accountId || "platform"}`)

      // Create the checkout session
      const session = await createCheckoutSession(
        items,
        userId,
        accountId && accountId !== "platform" ? accountId : undefined,
      )

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
    else {
      console.log("Creating multiple checkout sessions for different accounts")

      // For simplicity in this example, we'll create a checkout session for each account
      // and return the URL for the first one
      // In a real implementation, you'd need a more sophisticated approach

      const sessions = await Promise.all(
        Object.entries(itemsByAccount).map(async ([accountId, accountItems]) => {
          if (accountId === "platform") {
            return createCheckoutSession(accountItems, userId)
          } else {
            return createCheckoutSession(accountItems, userId, accountId)
          }
        }),
      )

      // For this example, just return the first session URL
      // In a real implementation, you might want to create a custom checkout page
      // that handles multiple sessions

      return NextResponse.json(
        { url: sessions[0].url },
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
      { error: "Failed to create checkout session", details: error instanceof Error ? error.message : "Unknown error" },
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
async function createCheckoutSession(items: CartItem[], userId: string, stripeConnectedAccountId?: string) {
  // Calculate the application fee percentage (e.g., 10%)
  const applicationFeePercent = 10

  const lineItems = items.map((item: CartItem) => ({
    price: item.priceId,
    quantity: item.quantity,
  }))

  // Get the base URL for success and cancel URLs
  const baseUrl = process.env.FRONTEND_URL || "https://ui-app.com"

  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    payment_method_types: ["card"],
    mode: "payment",
    line_items: lineItems,
    success_url: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/cancel`,
    metadata: {
      user_id: userId,
      product_ids: items.map((item: CartItem) => item.id).join(","),
      product_names: items.map((item: CartItem) => item.name || "").join(","),
      vendor_names: items.map((item: CartItem) => item.vendorName || "").join(","),
      vendor_emails: items.map((item: CartItem) => item.vendorEmail || "").join(","),
    },
  }

  // If we have a Stripe Connected Account ID, add it to the session params
  if (stripeConnectedAccountId) {
    console.log(`Creating checkout session with Connected Account: ${stripeConnectedAccountId}`)

    // Get the total amount for these items to calculate the application fee
    let totalAmount = 0
    for (const item of items) {
      try {
        const price = await stripe.prices.retrieve(item.priceId)
        if (price.unit_amount) {
          totalAmount += price.unit_amount * item.quantity
        }
      } catch (err) {
        console.error(`Error retrieving price ${item.priceId}:`, err)
      }
    }

    // Calculate the application fee amount
    const applicationFeeAmount = Math.round(totalAmount * (applicationFeePercent / 100))

    console.log(`Total amount: ${totalAmount}, Application fee: ${applicationFeeAmount}`)

    // Add the payment_intent_data with the application fee and transfer data
    sessionParams.payment_intent_data = {
      application_fee_amount: applicationFeeAmount,
      transfer_data: {
        destination: stripeConnectedAccountId,
      },
    }
  }

  try {
    const session = await stripe.checkout.sessions.create(sessionParams)
    console.log(`Created checkout session: ${session.id}, URL: ${session.url}`)
    return session
  } catch (error) {
    console.error("Error creating checkout session:", error)
    throw error
  }
}

