import { NextResponse } from "next/server"
import Stripe from "stripe"

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: "2025-02-24.acacia",
})

// The account group ID
const ACCOUNT_GROUP_ID = "acctgrp_ReaChY6ZbHKyvb"

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
  userEmail?: string
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
    const { items, userId, userEmail }: CheckoutRequest = await req.json()

    console.log("Checkout server received request:", { userId, userEmail, itemCount: items.length })

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

    // Filter items to only include those with connected account IDs
    const connectedItems = items.filter((item) => item.stripeConnectedAccountId)

    console.log(
      "Items with Connected Account IDs:",
      connectedItems.map((item) => ({
        id: item.id,
        name: item.name,
        stripeConnectedAccountId: item.stripeConnectedAccountId,
      })),
    )

    // Get the base URL for success and cancel URLs
    const baseUrl = process.env.FRONTEND_URL || "https://ui-app.com"

    // Prepare line items for the checkout session
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = []

    // Add each item to the checkout
    for (const item of items) {
      lineItems.push({
        price: item.priceId,
        quantity: item.quantity,
      })
    }

    // Extract connected account IDs
    const connectedAccountIds = connectedItems
      .map((item) => item.stripeConnectedAccountId)
      .filter((id): id is string => !!id)

    // Prepare session parameters
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      payment_method_types: ["card"],
      mode: "payment",
      line_items: lineItems,
      success_url: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/cancel`,
      metadata: {
        user_id: userId,
        product_ids: items.map((item) => item.id).join(","),
        product_names: items.map((item) => item.name || "").join(","),
        vendor_names: items.map((item) => item.vendorName || "").join(","),
        vendor_emails: items.map((item) => item.vendorEmail || "").join(","),
        connected_account_ids: connectedAccountIds.join(","),
      },
    }

    // If we have a user email, try to find an existing customer
    if (userEmail) {
      try {
        const customers = await stripe.customers.list({
          email: userEmail,
          limit: 1,
        })

        if (customers.data.length > 0) {
          sessionParams.customer = customers.data[0].id
        } else {
          sessionParams.customer_email = userEmail
        }
      } catch (error) {
        console.error("Error finding customer:", error)
        sessionParams.customer_email = userEmail
      }
    }

    // Set up the payment intent data with transfer group
    sessionParams.payment_intent_data = {
      transfer_group: ACCOUNT_GROUP_ID,
      // Make sure metadata is preserved
      metadata: {
        connected_account_ids: connectedAccountIds.join(","),
      },
    }

    // Create the checkout session
    const session = await stripe.checkout.sessions.create(sessionParams)
    console.log(`Created checkout session: ${session.id}, URL: ${session.url}`)

    return NextResponse.json(
      { url: session.url },
      {
        headers: {
          "Access-Control-Allow-Origin": "https://ui-app.com",
        },
      },
    )
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
