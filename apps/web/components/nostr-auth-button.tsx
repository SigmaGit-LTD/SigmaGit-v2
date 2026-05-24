"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Loader2, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { authClient } from "@/lib/auth-client";
import { getApiUrl } from "@/lib/utils";

// Nostr window extension type
declare global {
  interface Window {
    nostr?: {
      getPublicKey: () => Promise<string>;
      signEvent: (event: unknown) => Promise<unknown>;
    };
    alby?: {
      nwc?: {
        enable: (options: { name: string; description: string }) => Promise<{
          connectionString: string;
        }>;
      };
    };
  }
}

interface NostrProfile {
  name?: string;
  displayName?: string;
  about?: string;
  bio?: string;
  picture?: string;
  avatarUrl?: string;
  banner?: string;
  bannerUrl?: string;
}

interface NostrAuthButtonProps {
  onSuccess?: () => void;
  variant?: "default" | "outline" | "ghost";
  className?: string;
}

export function NostrAuthButton({
  onSuccess,
  variant = "outline",
  className,
}: NostrAuthButtonProps) {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [hasExtension, setHasExtension] = useState(false);
  const [showNoExtensionDialog, setShowNoExtensionDialog] = useState(false);

  useEffect(() => {
    // Check for Nostr extension
    setHasExtension(typeof window !== "undefined" && !!window.nostr);
  }, []);

  async function fetchNostrProfile(_pubkey: string): Promise<NostrProfile | null> {
    try {
      setStatus("Fetching profile from relays...");

      // Profile fetching is done server-side
      // The client just provides the pubkey
      return null;
    } catch {
      return null;
    }
  }

  async function getNWCConnectionString(): Promise<string | null> {
    try {
      // Check for Alby extension with NWC support
      if (window.alby?.nwc?.enable) {
        const nwc = await window.alby.nwc.enable({
          name: "SigmaGit",
          description: "Connect your Lightning wallet for Nostr Wallet Connect",
        });
        return nwc.connectionString;
      }

      // Check localStorage for stored NWC connections
      const keys = ["alby_nwc_connections", "alby_connections", "nwc_connections"];
      for (const key of keys) {
        const stored = localStorage.getItem(key);
        if (stored) {
          try {
            const connections = JSON.parse(stored);
            if (Array.isArray(connections) && connections.length > 0) {
              return connections[0].connectionString || connections[0];
            }
          } catch {
            // Invalid JSON, skip
          }
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  async function handleNostrAuth() {
    if (!window.nostr) {
      setShowNoExtensionDialog(true);
      return;
    }

    setLoading(true);
    setStatus("Connecting to Nostr extension...");

    try {
      // 1. Get public key from extension
      const pubkey = await window.nostr.getPublicKey();

      if (!pubkey) {
        throw new Error("No public key returned from extension");
      }

      // 2. Fetch server challenge (NIP-42)
      setStatus("Requesting challenge...");
      const challengeRes = await fetch(`${getApiUrl()}/api/auth/nostr/challenge`, {
        credentials: "include",
      });
      if (!challengeRes.ok) {
        throw new Error("Failed to get authentication challenge");
      }
      const { challenge } = (await challengeRes.json()) as { challenge: string };

      // 3. Sign challenge event with extension
      setStatus("Signing challenge...");
      const signedEvent = await window.nostr.signEvent({
        kind: 22242,
        pubkey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["challenge", challenge]],
        content: "",
      });

      // 4. Fetch profile metadata
      setStatus("Fetching profile...");
      const profile = await fetchNostrProfile(pubkey);

      // 5. Check for NWC (optional)
      setStatus("Checking for Lightning wallet...");
      const nwcConnectionString = await getNWCConnectionString();

      // 6. Send to server
      setStatus("Authenticating with server...");
      const response = await fetch(`${getApiUrl()}/api/auth/nostr`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          npub: pubkey,
          challenge,
          event: signedEvent,
          profile: profile || undefined,
          nwcConnectionString: nwcConnectionString || undefined,
        }),
      });

      // Get response text first to debug
      const responseText = await response.text();
      let data: { error?: string; success?: boolean } = {};

      try {
        data = JSON.parse(responseText);
      } catch {
        console.error("[Nostr Auth] Invalid JSON response:", responseText);
        throw new Error(`Server returned invalid JSON. Status: ${response.status}`);
      }

      if (!response.ok) {
        throw new Error(data.error || `Authentication failed (status ${response.status})`);
      }

      // Keep better-auth client state in sync so UI (header) updates immediately.
      const refreshed = await authClient.getSession();
      const hasSession = !!refreshed.data?.session;
      if (!hasSession && typeof window !== "undefined") {
        // Fallback for stale client cache edge-cases.
        window.location.assign("/");
        return;
      }

      toast.success("Welcome! Signed in with Nostr successfully.");
      onSuccess?.();
    } catch (error) {
      console.error("[Nostr Auth] Error:", error);
      toast.error(error instanceof Error ? error.message : "Failed to sign in with Nostr");
    } finally {
      setLoading(false);
      setStatus("");
    }
  }

  return (
    <>
      <Button
        type="button"
        variant={variant}
        onClick={handleNostrAuth}
        disabled={loading}
        className={className}
      >
        {loading ? (
          <>
            <Loader2 className="size-4 mr-2 animate-spin" />
            {status || "Connecting..."}
          </>
        ) : (
          <>
            <Zap className="size-4 mr-2 text-yellow-500" />
            Nostr
          </>
        )}
      </Button>

      <Dialog open={showNoExtensionDialog} onOpenChange={setShowNoExtensionDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="size-5 text-yellow-500" />
              Nostr Extension Required
            </DialogTitle>
            <DialogDescription>
              To sign in with Nostr, you need a Nostr browser extension like:
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="grid gap-3">
              <a
                href="https://getalby.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 p-3 rounded-lg border hover:bg-accent transition-colors"
              >
                <div className="size-8 rounded-full bg-orange-500 flex items-center justify-center text-white font-bold">
                  A
                </div>
                <div className="flex-1">
                  <div className="font-medium">Alby</div>
                  <div className="text-sm text-muted-foreground">
                    Bitcoin Lightning wallet with Nostr support
                  </div>
                </div>
              </a>

              <a
                href="https://chromewebstore.google.com/detail/nos2x/pbdahnlgabhdjlglnipnlalgpflbaggl"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 p-3 rounded-lg border hover:bg-accent transition-colors"
              >
                <div className="size-8 rounded-full bg-purple-500 flex items-center justify-center text-white font-bold">
                  n
                </div>
                <div className="flex-1">
                  <div className="font-medium">nos2x</div>
                  <div className="text-sm text-muted-foreground">
                    Simple Nostr signer extension
                  </div>
                </div>
              </a>

              <a
                href="https://chromewebstore.google.com/detail/nostr-connect/ampjiinddmgganaiokfplkdpojbhgfik"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 p-3 rounded-lg border hover:bg-accent transition-colors"
              >
                <div className="size-8 rounded-full bg-blue-500 flex items-center justify-center text-white font-bold">
                  nc
                </div>
                <div className="flex-1">
                  <div className="font-medium">Nostr Connect</div>
                  <div className="text-sm text-muted-foreground">
                    Connect to remote Nostr keys
                  </div>
                </div>
              </a>
            </div>

            <p className="text-sm text-muted-foreground text-center">
              Install one of these extensions and refresh the page to sign in with Nostr.
            </p>
          </div>

          <div className="flex justify-end">
            <Button variant="outline" onClick={() => setShowNoExtensionDialog(false)}>
              Got it
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
