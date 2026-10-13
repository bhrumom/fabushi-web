import type { Metadata } from "next";
import { siteUrl } from "../../lib/site-url";
import { DachengChatShell } from "./dacheng-chat-shell";

// This application is distinct from the informational homepage.
export const metadata: Metadata = {
  title: "Fabushi Web App",
  alternates: { canonical: siteUrl("/app") },
};

export default function WebAppPage() {
  return <DachengChatShell />;
}
