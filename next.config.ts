import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
    env: {
        STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    },
    // Optional: Configure API routes to be server-side only
    
  }
  
  export default nextConfig
