import type { Metadata, Viewport } from "next";
import "./globals.css";
import { I18nProvider } from "@/lib/i18n/client";
import { DICTIONARIES } from "@/lib/i18n/dictionaries";
import { getLocale } from "@/lib/i18n/server";
import { NavShopsProvider, ShopProvider, type NavShop, type ShopInfo } from "@/lib/shop-context";
import { getShop, getShopByDomain } from "@/lib/server/shop";
import { dashboardShops } from "../../scripts/lib/dashboard-shops.mjs";
import { getMarketplaces } from "@/lib/server/marketplaces";

/** The shop row, or nothing: a page must not fail because `shops` could not be read. */
async function readShopInfo(): Promise<ShopInfo> {
  try {
    const [shop, marketplaces] = await Promise.all([getShop(), getMarketplaces()]);
    return {
      name: shop?.shopName ?? null,
      storefrontUrl: shop?.storefrontUrl ?? null,
      marketplaces: marketplaces.list.map((m) => ({ key: m.key, label: m.label })),
    };
  } catch {
    return { name: null, storefrontUrl: null, marketplaces: [] };
  }
}

/**
 * Every shop the dashboard serves, for the sidebar's switcher. A shop not synced
 * yet is still listed, under its slug; a failed read never fails a page.
 */
async function readNavShops(): Promise<NavShop[]> {
  const shops = dashboardShops(process.env) as { slug: string; domain: string; desk: boolean }[];
  return Promise.all(
    shops.map(async (shop) => {
      const row = await getShopByDomain(shop.domain).catch(() => null);
      return {
        slug: shop.slug,
        name: row?.shopName?.trim() || shop.slug,
        desk: shop.desk,
        storefrontUrl: row?.storefrontUrl ?? null,
        logo: shop.desk ? "/brand/logo.png" : `/brand/shops/${shop.slug}.png`,
      };
    })
  );
}

// THE TITLE NAMES THE SHOP FROM ITS DATA. Every page used to end its title with
// « · Qiriness Support OS »; now each page gives only its own part and this
// template adds the shop's name.
export async function generateMetadata(): Promise<Metadata> {
  const { name } = await readShopInfo();
  const product = name ? `${name} Support OS` : "Support OS";
  return {
    title: { template: `%s · ${product}`, default: `Agent Setup · ${product}` },
    description: "Configure the knowledge, brand voice, and tone your reply agent will use.",
    // One file serves both the tab icon and the brand mark in the app shell, so
    // the two cannot drift apart. `.png` paths are excluded from the middleware
    // matcher, which is what lets the sign-in page show it without a session.
    // A neutral name: another shop replaces the file, not the code.
    icons: { icon: { url: "/brand/logo.png", type: "image/png", sizes: "32x32" } },
  };
}

export const viewport: Viewport = {
  themeColor: "#008080",
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = getLocale();
  const [shop, navShops] = await Promise.all([readShopInfo(), readNavShops()]);
  return (
    <html lang={locale}>
      <body>
        <ShopProvider shop={shop}>
          <NavShopsProvider shops={navShops}>
            <I18nProvider locale={locale} messages={DICTIONARIES[locale]}>{children}</I18nProvider>
          </NavShopsProvider>
        </ShopProvider>
      </body>
    </html>
  );
}
