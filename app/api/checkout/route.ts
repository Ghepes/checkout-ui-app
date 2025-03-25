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
        userEmail,
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
    // If we have items from multiple accounts, create a separate checkout for each vendor
    else {
      console.log("Creating multiple checkout sessions for different accounts")

      // Create a checkout session for each vendor account plus one for platform items if any
      const checkoutSessions = []

      // First, handle platform items if any
      if (itemsByAccount["platform"] && itemsByAccount["platform"].length > 0) {
        const platformSession = await createCheckoutSession(itemsByAccount["platform"], userId, userEmail)
        checkoutSessions.push({
          accountId: "platform",
          session: platformSession,
          items: itemsByAccount["platform"],
        })
      }

      // Then handle each vendor's items
      for (const accountId of Object.keys(itemsByAccount)) {
        if (accountId !== "platform") {
          const vendorItems = itemsByAccount[accountId]
          const vendorSession = await createCheckoutSession(vendorItems, userId, userEmail, accountId)
          checkoutSessions.push({
            accountId,
            session: vendorSession,
            items: vendorItems,
          })
        }
      }

      // Create a special checkout page that will handle multiple sessions
      // For now, we'll just return the first session URL with information about multiple vendors
      if (checkoutSessions.length > 0) {
        // Store the session information for later use
        // In a real implementation, you would store this in a database
        const sessionInfo = {
          userId,
          sessions: checkoutSessions.map((s) => ({
            sessionId: s.session.id,
            accountId: s.accountId,
            amount: s.session.amount_total,
            url: s.session.url,
            items: s.items.map((item) => ({
              id: item.id,
              name: item.name,
              price: item.price,
              quantity: item.quantity,
            })),
          })),
        }

        console.log("Created multiple checkout sessions:", sessionInfo)

        // Return the first session URL with a flag indicating multiple vendors
        return NextResponse.json(
          {
            url: checkoutSessions[0].session.url,
            multipleVendors: true,
            vendorCount: checkoutSessions.length,
            totalAmount: checkoutSessions.reduce((sum, s) => sum + (s.session.amount_total || 0), 0) / 100,
          },
          {
            headers: {
              "Access-Control-Allow-Origin": "https://ui-app.com",
            },
          },
        )
      } else {
        throw new Error("Failed to create any checkout sessions")
      }
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

// Helper function to create a checkout session
async function createCheckoutSession(
  items: CartItem[],
  userId: string,
  userEmail?: string,
  stripeConnectedAccountId?: string,
) {
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
      connected_account_id: stripeConnectedAccountId || "",
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

