import { NextResponse } from "next/server";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);

interface CartItem {
  id: string;
  priceId: string;
  quantity: number;
}

interface CheckoutRequest {
  items: CartItem[];
  userId: string;
}

export async function POST(req: Request) {
  // Handle CORS preflight request
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': 'https://ui-app.com',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  try {
    const { items, userId }: CheckoutRequest = await req.json();

    if (!items || !items.length) {
      return NextResponse.json(
        { error: "Cart is empty" },
        { 
          status: 400,
          headers: {
            'Access-Control-Allow-Origin': 'https://ui-app.com',
          }
        }
      );
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: items.map((item: CartItem) => ({
        price: item.priceId,
        quantity: item.quantity,
      })),
      success_url: `https://ui-app.com/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://ui-app.com/cart`,
      metadata: {
        user_id: userId,
        product_ids: items.map((item: CartItem) => item.id).join(","),
      },
    });

    return NextResponse.json(
      { url: session.url },
      {
        headers: {
          'Access-Control-Allow-Origin': 'https://ui-app.com',
        }
      }
    );
  } catch (error) {
    console.error("Checkout API error:", error);
    return NextResponse.json(
      { error: "Failed to create checkout session" },
      { 
        status: 500,
        headers: {
          'Access-Control-Allow-Origin': 'https://ui-app.com',
        }
      }
    );
  }
}
