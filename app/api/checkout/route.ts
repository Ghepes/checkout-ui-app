import { NextResponse } from "next/server"
import Stripe from "stripe"

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: "2025-02-24.acacia",
})

// The correct transfer group ID
const ACCOUNT_GROUP_ID = process.env.ACCOUNT_GROUP_ID || "default"

interface CartItem {
  id: string
  priceId: string
  quantity: number
  stripeConnectedAccountId?: string | null
  name?: string
  vendorName?: string
  vendorEmail?: string
  price?: number
  productImage?: string
  productDev0?: string
}

interface CheckoutRequest {
  items: CartItem[]
  userId: string
  userEmail?: string
  accountGroupId?: string
  connectedAccountIds?: string[]
}

export async function POST(req: Request) {
  // Handle CORS preflight request
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    })
  }

  try {
    const {
      items,
      userId,
      userEmail,
      accountGroupId = ACCOUNT_GROUP_ID,
      connectedAccountIds = [],
    }: CheckoutRequest = await req.json()

    console.log("Checkout server received request:", {
      userId,
      userEmail,
      itemCount: items.length,
      accountGroupId,
      connectedAccountIds,
    })

    if (!items || !items.length) {
      return NextResponse.json(
        { error: "Cart is empty" },
        {
          status: 400,
          headers: {
            "Access-Control-Allow-Origin": "*",
          },
        },
      )
    }

    // Get the base URL for success and cancel URLs
    const baseUrl = process.env.FRONTEND_URL || "https://ui-app.com"

    // Extract connected account IDs from items if not provided
    const itemConnectedAccountIds = items
      .map((item) => item.stripeConnectedAccountId)
      .filter((id): id is string => !!id)

    // Use provided connected account IDs or extract from items
    const finalConnectedAccountIds = connectedAccountIds.length > 0 ? connectedAccountIds : itemConnectedAccountIds

    // Prepare line items for the checkout session
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = []

    // Add each item to the checkout
    for (const item of items) {
      lineItems.push({
        price: item.priceId,
        quantity: item.quantity,
      })
    }

    // Create product-to-connected-account mapping for better tracking
    const productConnectedAccounts = items
      .filter((item) => item.stripeConnectedAccountId)
      .map((item) => `${item.id}:${item.stripeConnectedAccountId}`)
      .join(",")

    // Collect all product details for metadata
    const productDetails = items.map((item) => ({
      id: item.id,
      name: item.name || "Unknown Product",
      image: item.productImage || "",
      downloadUrl: item.productDev0 || "",
    }))

    // Log product details for debugging
    console.log("Product details for metadata:", productDetails)

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
        connected_account_ids: finalConnectedAccountIds.join(","),
        product_connected_accounts: productConnectedAccounts,
        // Add crucial fields for MongoDB storage
        productDev0: items.map((item) => item.productDev0 || "").join(","),
        product_images: items.map((item) => item.productImage || "").join(","),
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
      transfer_group: accountGroupId,
      metadata: {
        connected_account_ids: finalConnectedAccountIds.join(","),
        product_connected_accounts: productConnectedAccounts,
        // Also include crucial fields in payment intent metadata
        productDev0: items.map((item) => item.productDev0 || "").join(","),
        product_images: items.map((item) => item.productImage || "").join(","),
        product_names: items.map((item) => item.name || "").join(","),
      },
    }

    // Log the session parameters for debugging
    console.log("Creating checkout session with params:", {
      lineItems: sessionParams.line_items?.length,
      metadata: sessionParams.metadata,
      paymentIntentMetadata: sessionParams.payment_intent_data?.metadata,
    })

    // Create the checkout session
    const session = await stripe.checkout.sessions.create(sessionParams)
    console.log(`Created checkout session: ${session.id}, URL: ${session.url}`)

    return NextResponse.json(
      { url: session.url },
      {
        headers: {
          "Access-Control-Allow-Origin": "*",
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
          "Access-Control-Allow-Origin": "*",
        },
      },
    )
  }
}
