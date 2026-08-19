import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { http } from "../api";
import { useAuth } from "../auth";

/**
 * The signed-in user's cart, shared between the header badge and the shop pages.
 *
 * The server is the only source of truth — it re-prices every line against the live
 * catalogue on each read, so a price change or a sell-out shows up rather than being
 * honoured from a stale client copy. There is deliberately no local-storage cart: the
 * brief requires an account to check out, so there is no anonymous state to preserve.
 */
const CartCtx = createContext({ cart: null, loading: false, refresh: () => {}, setCart: () => {} });

const EMPTY = { items: [], subtotal_ron: 0, count: 0, has_problems: false };

export function CartProvider({ children }) {
  const { user } = useAuth();
  const [cart, setCart] = useState(EMPTY);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) { setCart(EMPTY); return; }
    setLoading(true);
    try {
      const { data } = await http.get("/shop/cart");
      setCart(data);
    } catch {
      setCart(EMPTY);
    } finally {
      setLoading(false);
    }
  }, [user]);

  // Signing in adopts whatever was left in the account's cart; signing out clears the
  // badge immediately rather than showing the previous user's count.
  useEffect(() => { refresh(); }, [refresh]);

  return <CartCtx.Provider value={{ cart, loading, refresh, setCart }}>{children}</CartCtx.Provider>;
}

export const useCart = () => useContext(CartCtx);

/** Prices are stored and displayed gross, in RON. */
export const ron = (n) => `${Number(n || 0).toFixed(2)} RON`;
