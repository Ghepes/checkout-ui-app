import type { Metadata } from "next";
import React from "react";
import { Geist, Geist_Mono } from "next/font/google";
import cn from "classnames";
import { TooltipProvider } from "@geist-ui/core";
import "./globals.css";
import { SiteHeader } from "../components/site-header";
import { Toaster } from "react-hot-toast";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Checkout - UI-App",
  description: "ui-app.com",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#000000" />
        <meta name="description" content="ui-app.com" />
        <link rel="icon" href="/favicon.ico" />
        <link rel="apple-touch-icon" href="/logo192.png" />
        <link rel="preconnect" href="https://ui-app.com" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://user.ui-app.com" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://vendor.ui-app.com" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="//ui-app.com" />
        <link rel="dns-prefetch" href="//user.ui-app.com" />
        <link rel="dns-prefetch" href="//vendor.ui-app.com" />
        <link rel="preconnect" href="https://storage.googleapis.com" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="//storage.googleapis.com" />
        <link rel="dns-prefetch" href="//js.stripe.com" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://js.stripe.com" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="//api.stripe.com" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://api.stripe.com" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="//q.stripe.com" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://q.stripe.com" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="//m.stripe.com" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://m.stripe.com" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="//connect.stripe.com" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://connect.stripe.com" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="//marketplace.stripe.com" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://marketplace.stripe.com" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="//docs.stripe.com" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://docs.stripe.com" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="//support.stripe.com" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://support.stripe.com" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="//pay.ui-app.com" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://pay.ui-app.com" crossOrigin="anonymous" />
      </head>
      <body className={cn("flex min-h-screen flex-col antialiased", geistSans.variable)}>
        <TooltipProvider delayDuration={0}>
          <SiteHeader />
          <main className="flex-1">{children}</main>
          <Toaster />
        </TooltipProvider>
      </body>
    </html>
  );
}
