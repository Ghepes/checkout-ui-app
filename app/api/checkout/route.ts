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

async function findCustomerByEmail(email: string): Promise<string | null> {
  if (!email) return null
  try {
    const customers = await stripe.customers.list({
      email: email,
      limit: 1,
    })
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

async function createMultiVendorCheckoutSession(items: CartItem[], userId: string, userEmail?: string) {
  const applicationFeePercent = 10
  const baseUrl = process.env.FRONTEND_URL || "https://ui-app.com"
  
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = []
  const transferGroups: Record<string, { amount: number; application_fee: number }> = {}

  // Process each item and prepare line items and transfer groups
  for (const item of items) {
    try {
      const price = await stripe.prices.retrieve(item.priceId)
      if (!price.unit_amount) {
        console.warn(`Price ${item.priceId} has no unit_amount, skipping`)
        continue
      }

      lineItems.push({
        price: item.priceId,
        quantity: item.quantity,
      })

      if (item.stripeConnectedAccountId) {
        const totalAmount = price.unit_amount * item.quantity
        const applicationFee = Math.round(totalAmount * (applicationFeePercent / 100))
        const transferAmount = totalAmount - applicationFee

        if (transferGroups[item.stripeConnectedAccountId]) {
          transferGroups[item.stripeConnectedAccountId].amount += transferAmount
          transferGroups[item.stripeConnectedAccountId].application_fee += applicationFee
        } else {
          transferGroups[item.stripeConnectedAccountId] = {
            amount: transferAmount,
            application_fee: applicationFee,
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
      transfer_groups: JSON.stringify(transferGroups),
    },
    payment_intent_data: {
      transfer_group: `order_${userId}_${Date.now()}`,
    },
  }

  // Customer handling
  if (userEmail) {
    const existingCustomerId = await findCustomerByEmail(userEmail)
    if (existingCustomerId) {
      sessionParams.customer = existingCustomerId
    } else {
      sessionParams.customer_email = userEmail
    }
  }

  // Create the checkout session
  const session = await stripe.checkout.sessions.create(sessionParams)
  console.log(`Created checkout session: ${session.id}, URL: ${session.url}`)
  
  // IMPORTANT: You'll need to handle the actual transfers in a webhook
  // when the payment is successful, using the transfer_group and the data
  // stored in metadata.transfer_groups

  return session
}
