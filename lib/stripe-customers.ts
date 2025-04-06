import Stripe from "stripe"

// Initialize Stripe with your secret key
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: "2025-02-24.acacia",
})

/**
 * Find the best Stripe customer record for a given email
 * Prioritizes customers with payment methods, then most recent
 */
export async function findStripeCustomerByEmail(email: string): Promise<{
  customerId: string | null
  exists: boolean
  customer: Stripe.Customer | null
}> {
  if (!email) {
    return { customerId: null, exists: false, customer: null }
  }

  try {
    // Find all customers with this email
    const customers = await stripe.customers.list({
      email: email.toLowerCase(),
      limit: 100, // Increase limit to find all potential duplicates
      expand: ["data.sources", "data.payment_methods"],
    })

    if (customers.data.length === 0) {
      return { customerId: null, exists: false, customer: null }
    }

    // If we have multiple customers, find the best one
    if (customers.data.length > 1) {
      console.log(`Found ${customers.data.length} customers with email ${email}`)

      // First, look for customers with payment methods
    //  const customersWithPaymentMethods = customers.data.filter(
    //    (customer) => (customer.sources?.data?.length || 0) > 0 || (customer.payment_methods?.data?.length || 0) > 0,
    //  )

      // First, look for customers with payment methods
      const customersWithPaymentMethods = customers.data.filter(
        (customer) => (customer.sources?.data?.length || 0) > 0,
      )

      if (customersWithPaymentMethods.length > 0) {
        // Sort by creation date (newest first)
        const sortedCustomers = customersWithPaymentMethods.sort((a, b) => b.created - a.created)

        return {
          customerId: sortedCustomers[0].id,
          exists: true,
          customer: sortedCustomers[0],
        }
      }

      // If no customers have payment methods, use the most recently created one
      const sortedCustomers = customers.data.sort((a, b) => b.created - a.created)

      return {
        customerId: sortedCustomers[0].id,
        exists: true,
        customer: sortedCustomers[0],
      }
    }

    // Just one customer found
    return {
      customerId: customers.data[0].id,
      exists: true,
      customer: customers.data[0],
    }
  } catch (error) {
    console.error("Error finding Stripe customer:", error)
    return { customerId: null, exists: false, customer: null }
  }
}

/**
 * Ensure we have a valid Stripe customer for the given email
 * Will find existing customer or create a new one
 */
export async function ensureValidStripeCustomer(email: string, name?: string): Promise<string> {
  // First try to find an existing customer
  const { customerId, exists } = await findStripeCustomerByEmail(email)

  if (exists && customerId) {
    return customerId
  }

  // Create a new customer if none exists
  try {
    const customer = await stripe.customers.create({
      email: email.toLowerCase(),
      name: name || undefined,
      metadata: {
        is_primary: "true",
        created_by: "customer_management_system",
      },
    })

    return customer.id
  } catch (error) {
    console.error("Error creating Stripe customer:", error)
    throw new Error("Failed to create Stripe customer")
  }
}

/**
 * Get the primary customer ID for a given customer
 * Handles cases where the customer is a duplicate
 */
export async function getPrimaryCustomerId(customerId: string): Promise<string> {
  try {
    const customer = await stripe.customers.retrieve(customerId)

    // If this customer is marked as a duplicate, return its primary customer ID
    if (
      customer &&
      !("deleted" in customer) &&
      customer.metadata?.is_duplicate === "true" &&
      customer.metadata?.primary_customer_id
    ) {
      return customer.metadata.primary_customer_id
    }

    // Otherwise, return the original customer ID
    return customerId
  } catch (error) {
    console.error(`Error getting primary customer ID for ${customerId}:`, error)
    return customerId
  }
}

