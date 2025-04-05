import { NextResponse } from "next/server"
import Stripe from "stripe"

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: "2025-02-24.acacia",
})

// The correct transfer group ID
const ACCOUNT_GROUP_ID = "default"

// The payments pricing group ID - this is used for connected accounts
const PAYMENTS_PRICING_GROUP_ID = "acctgrp_S38FZGJsPr1nRk"

interface CartItem {
  id: string
  priceId: string
  quantity: number
  stripeConnectedAccountId?: string | null
  name?: string
  vendorName?: string
  vendorEmail?: string
  price?: number
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

    // Group items by vendor (connected account ID)
    const itemsByVendor: Record<string, CartItem[]> = {}
    const platformItems: CartItem[] = []

    // Extract connected account IDs from items if not provided
    const itemConnectedAccountIds = items
      .map((item) => item.stripeConnectedAccountId)
      .filter((id): id is string => !!id)

    // Use provided connected account IDs or extract from items
    const finalConnectedAccountIds = connectedAccountIds.length > 0 ? connectedAccountIds : itemConnectedAccountIds

    // Group items by vendor
    for (const item of items) {
      if (item.stripeConnectedAccountId) {
        if (!itemsByVendor[item.stripeConnectedAccountId]) {
          itemsByVendor[item.stripeConnectedAccountId] = []
        }
        itemsByVendor[item.stripeConnectedAccountId].push(item)
      } else {
        platformItems.push(item)
      }
    }

    // Check if we have multiple vendors
    const vendorIds = Object.keys(itemsByVendor)
    const hasMultipleVendors = vendorIds.length > 1 || (vendorIds.length === 1 && platformItems.length > 0)

    // If we have a single vendor or only platform items, create a single checkout session
    if (!hasMultipleVendors) {
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
          payments_pricing_group_id: PAYMENTS_PRICING_GROUP_ID,
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

      // If we have a connected account, use application fee and transfer data
      const connectedAccountId = vendorIds[0]
      if (connectedAccountId) {
        // Calculate total amount for this vendor
        const vendorItems = itemsByVendor[connectedAccountId]
        const totalAmount = vendorItems.reduce((sum, item) => {
          const itemPrice = (item.price || 0) * 100 // Convert to cents
          return sum + itemPrice * item.quantity
        }, 0)

        // Calculate 10% fee
        const applicationFeeAmount = Math.round(totalAmount * 0.1)

        // Set up the payment intent data with transfer data
        sessionParams.payment_intent_data = {
          transfer_data: {
            destination: connectedAccountId,
          },
          application_fee_amount: applicationFeeAmount,
          metadata: {
            connected_account_ids: finalConnectedAccountIds.join(","),
            product_connected_accounts: productConnectedAccounts,
            payments_pricing_group_id: PAYMENTS_PRICING_GROUP_ID,
          },
          automatic_payment_methods: { enabled: true },
          automatic_currency_conversion: true, // Enable automatic currency conversion
        }
      } else {
        // Regular payment intent data for platform-only items
        sessionParams.payment_intent_data = {
          transfer_group: accountGroupId,
          metadata: {
            connected_account_ids: finalConnectedAccountIds.join(","),
            product_connected_accounts: productConnectedAccounts,
            payments_pricing_group_id: PAYMENTS_PRICING_GROUP_ID,
          },
          automatic_payment_methods: { enabled: true },
          automatic_currency_conversion: true, // Enable automatic currency conversion
        }
      }

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
    } else {
      // For multiple vendors, we need to create separate checkout sessions
      // First, calculate the total amount for all items
      const totalAmount = items.reduce((sum, item) => {
        const itemPrice = (item.price || 0) * 100 // Convert to cents
        return sum + itemPrice * item.quantity
      }, 0)

      // Create a session for the first vendor
      const firstVendorId = vendorIds[0]
      const firstVendorItems = itemsByVendor[firstVendorId]

      // Prepare line items for the first vendor
      const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = []
      for (const item of firstVendorItems) {
        lineItems.push({
          price: item.priceId,
          quantity: item.quantity,
        })
      }

      // Calculate vendor-specific amount and fee
      const vendorAmount = firstVendorItems.reduce((sum, item) => {
        const itemPrice = (item.price || 0) * 100 // Convert to cents
        return sum + itemPrice * item.quantity
      }, 0)

      // Calculate 10% fee based on this vendor's portion
      const applicationFeeAmount = Math.round(vendorAmount * 0.1)

      // Create product-to-connected-account mapping
      const productConnectedAccounts = firstVendorItems.map((item) => `${item.id}:${firstVendorId}`).join(",")

      // Prepare session parameters for the first vendor
      const sessionParams: Stripe.Checkout.SessionCreateParams = {
        payment_method_types: ["card"],
        mode: "payment",
        line_items: lineItems,
        success_url: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}&multi_vendor=true&vendor_count=${vendorIds.length}&total_amount=${totalAmount}`,
        cancel_url: `${baseUrl}/cancel`,
        metadata: {
          user_id: userId,
          product_ids: firstVendorItems.map((item) => item.id).join(","),
          product_names: firstVendorItems.map((item) => item.name || "").join(","),
          vendor_names: firstVendorItems.map((item) => item.vendorName || "").join(","),
          vendor_emails: firstVendorItems.map((item) => item.vendorEmail || "").join(","),
          connected_account_ids: firstVendorId,
          product_connected_accounts: productConnectedAccounts,
          payments_pricing_group_id: PAYMENTS_PRICING_GROUP_ID,
          is_multi_vendor: "true",
          vendor_count: vendorIds.length.toString(),
          total_amount: totalAmount.toString(),
          current_vendor_index: "1",
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

      // Set up the payment intent data with transfer data for the connected account
      sessionParams.payment_intent_data = {
        transfer_data: {
          destination: firstVendorId,
        },
        application_fee_amount: applicationFeeAmount,
        metadata: {
          connected_account_ids: firstVendorId,
          product_connected_accounts: productConnectedAccounts,
          payments_pricing_group_id: PAYMENTS_PRICING_GROUP_ID,
          is_multi_vendor: "true",
          vendor_count: vendorIds.length.toString(),
          current_vendor_index: "1",
        },
        automatic_payment_methods: { enabled: true },
        automatic_currency_conversion: true, // Enable automatic currency conversion
      }

      // Create the checkout session for the first vendor
      const session = await stripe.checkout.sessions.create(sessionParams)
      console.log(`Created multi-vendor checkout session: ${session.id}, URL: ${session.url}`)

      return NextResponse.json(
        {
          url: session.url,
          multipleVendors: true,
          vendorCount: vendorIds.length,
          totalAmount: totalAmount / 100, // Convert back to dollars for display
        },
        {
          headers: {
            "Access-Control-Allow-Origin": "*",
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
          "Access-Control-Allow-Origin": "*",
        },
      },
    )
  }
}
