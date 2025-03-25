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

    // Log the items with their Connected Account IDs
    console.log(
      "Items with Connected Account IDs:",
      items.map((item) => ({
        id: item.id,
        name: item.name,
        stripeConnectedAccountId: item.stripeConnectedAccountId || "none",
      })),
    )

    // Create a single checkout session that handles all vendors
    const session = await createMultiVendorCheckoutSession(items, userId, userEmail)

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

// Helper function to find existing customer by email
async function findCustomerByEmail(email: string): Promise<string | null> {
  if (!email) return null

  try {
    // Search for customers with the given email
    const customers = await stripe.customers.list({
      email: email,
      limit: 1,
    })

    // If a customer with this email exists, return their ID
    if (customers.data.length > 0) {
      console.log(`Found existing customer with email ${email}: ${customers.data[0].id}`)
      return customers.data[0].id
    }

    return null
  } catch (error) {
    console.error("Error finding customer by email:", error)
    return null
  }
}

// Create a checkout session that handles multiple vendors
async function createMultiVendorCheckoutSession(items: CartItem[], userId: string, userEmail?: string) {
  // Calculate the application fee percentage (e.g., 10%)
  const applicationFeePercent = 10

  // Get the base URL for success and cancel URLs
  const baseUrl = process.env.FRONTEND_URL || "https://ui-app.com"

  // Prepare line items with payment intent data for each vendor
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = []
  const transferDataItems: Record<string, { amount: number; destination: string }> = {}

  // Process each item and prepare line items and transfer data
  for (const item of items) {
    try {
      // Get the price details to calculate the correct amount
      const price = await stripe.prices.retrieve(item.priceId)

      if (!price.unit_amount) {
        console.warn(`Price ${item.priceId} has no unit_amount, skipping`)
        continue
      }

      // Add the line item to the checkout
      lineItems.push({
        price: item.priceId,
        quantity: item.quantity,
      })

      // If this item has a connected account, prepare transfer data
      if (item.stripeConnectedAccountId) {
        const totalAmount = price.unit_amount * item.quantity
        const feeAmount = Math.round(totalAmount * (applicationFeePercent / 100))
        const transferAmount = totalAmount - feeAmount

        // Add or update transfer data for this connected account
        if (transferDataItems[item.stripeConnectedAccountId]) {
          transferDataItems[item.stripeConnectedAccountId].amount += transferAmount
        } else {
          transferDataItems[item.stripeConnectedAccountId] = {
            amount: transferAmount,
            destination: item.stripeConnectedAccountId,
          }
        }
      }
    } catch (error) {
      console.error(`Error processing item ${item.id}:`, error)
    }
  }

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
      connected_account_ids: Object.keys(transferDataItems).join(","),
    },
  }

  // If we have a user email, try to find an existing customer
  if (userEmail) {
    const existingCustomerId = await findCustomerByEmail(userEmail)

    if (existingCustomerId) {
      // Use the existing customer ID
      sessionParams.customer = existingCustomerId
    } else {
      // If no existing customer, set the email for the new customer
      sessionParams.customer_email = userEmail
    }
  }

  // If we have transfer data, set up payment intent data
  if (Object.keys(transferDataItems).length > 0) {
    // For multiple vendors, we need to use Stripe's transfer API after payment is complete
    // We'll store the transfer data in the payment intent metadata
    sessionParams.payment_intent_data = {
      metadata: {
        transfer_data: JSON.stringify(Object.values(transferDataItems)),
      },
    }
  }

  try {
    const session = await stripe.checkout.sessions.create(sessionParams)
    console.log(`Created checkout session: ${session.id}, URL: ${session.url}`)

    // Log transfer data for debugging
    if (Object.keys(transferDataItems).length > 0) {
      console.log("Transfer data for vendors:", transferDataItems)
    }

    return session
  } catch (error) {
    console.error("Error creating checkout session:", error)
    throw error
  }
}

