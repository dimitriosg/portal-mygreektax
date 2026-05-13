import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import type { TemplateData, TemplateEntry } from "./registry";

const SITE_NAME = "My Greek Tax";

export type ActivitySummaryRow = {
  when: string; // formatted "Wed 7 May, 14:32"
  actor: string; // "John Doe (john@x.com)" or "Client" or "—"
  description: string; // "Changed status of JB104 from Pending → Paid"
};

export type ActivitySummarySection = {
  title: string; // "Job status changes"
  count: number;
  rows: ActivitySummaryRow[];
};

export interface ActivitySummaryProps {
  period?: "daily" | "weekly";
  rangeLabel?: string; // e.g. "Wed 7 May 2026" or "Mon 5 May – Sun 11 May 2026"
  totals?: { label: string; value: number }[];
  sections?: ActivitySummarySection[];
  recipientName?: string;
}

const ActivitySummaryEmail = ({
  period = "daily",
  rangeLabel = "Yesterday",
  totals = [],
  sections = [],
  recipientName,
}: ActivitySummaryProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>
      {period === "weekly" ? "Weekly" : "Daily"} portal activity · {rangeLabel}
    </Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>
          {period === "weekly" ? "Weekly portal activity" : "Daily portal activity"}
        </Heading>
        <Text style={subtitle}>{rangeLabel}</Text>
        {recipientName ? <Text style={text}>Hi {recipientName},</Text> : null}
        <Text style={text}>
          Here's a summary of partner and customer activity on the {SITE_NAME} portal for the period
          above.
        </Text>

        {totals.length > 0 ? (
          <Section style={totalsBox}>
            {totals.map((t) => (
              <Text key={t.label} style={totalsRow}>
                <span style={totalsLabel}>{t.label}</span>
                <span style={totalsValue}>{t.value}</span>
              </Text>
            ))}
          </Section>
        ) : null}

        {sections.length === 0 ? (
          <Text style={empty}>No activity recorded for this period.</Text>
        ) : (
          sections.map((s) => (
            <Section key={s.title} style={section}>
              <Heading as="h2" style={h2}>
                {s.title} <span style={count}>({s.count})</span>
              </Heading>
              {s.rows.length === 0 ? (
                <Text style={muted}>None.</Text>
              ) : (
                s.rows.map((r, i) => (
                  <Text key={i} style={rowText}>
                    <span style={rowWhen}>{r.when}</span>
                    <br />
                    <span style={rowActor}>{r.actor}</span> — {r.description}
                  </Text>
                ))
              )}
            </Section>
          ))
        )}

        <Hr style={hr} />
        <Text style={footer}>
          You're receiving this because you have admin access to {SITE_NAME}'s partner portal.
        </Text>
      </Container>
    </Body>
  </Html>
);

export const template = {
  component: ActivitySummaryEmail,
  subject: (data: TemplateData) => {
    const period = (data.period as string) ?? "daily";
    const range = (data.rangeLabel as string) ?? "";
    return period === "weekly"
      ? `Weekly portal activity · ${range}`
      : `Daily portal activity · ${range}`;
  },
  displayName: "Activity summary",
  previewData: {
    period: "daily",
    rangeLabel: "Wed 7 May 2026",
    totals: [
      { label: "Partner logins", value: 4 },
      { label: "Job status changes", value: 6 },
      { label: "Tracking links opened", value: 3 },
    ],
    sections: [
      {
        title: "Job status changes",
        count: 2,
        rows: [
          {
            when: "Wed 7 May, 14:32",
            actor: "Maria Papadaki (maria@example.com)",
            description: "JB104 — Pending → Paid",
          },
          {
            when: "Wed 7 May, 16:08",
            actor: "Nikos K. (nikos@example.com)",
            description: "JB098 — In Progress → Delivered",
          },
        ],
      },
    ],
    recipientName: "Alex",
  },
} satisfies TemplateEntry;

const main = { backgroundColor: "#ffffff", fontFamily: "Arial, sans-serif" };
const container = { padding: "32px 28px", maxWidth: "640px" };
const h1 = { fontSize: "22px", fontWeight: 700, color: "#0b1220", margin: "0 0 4px" };
const h2 = { fontSize: "15px", fontWeight: 600, color: "#0b1220", margin: "0 0 8px" };
const subtitle = { fontSize: "13px", color: "#6b7280", margin: "0 0 20px" };
const text = { fontSize: "14px", color: "#374151", lineHeight: "1.6", margin: "0 0 16px" };
const empty = {
  fontSize: "14px",
  color: "#6b7280",
  fontStyle: "italic" as const,
  margin: "16px 0",
};
const muted = { fontSize: "13px", color: "#9ca3af", margin: "0 0 8px" };
const totalsBox = {
  backgroundColor: "#f3f4f6",
  borderRadius: "8px",
  padding: "14px 18px",
  margin: "0 0 24px",
};
const totalsRow = {
  display: "flex",
  justifyContent: "space-between",
  fontSize: "13px",
  color: "#0b1220",
  margin: "4px 0",
};
const totalsLabel = { color: "#374151" };
const totalsValue = { fontWeight: 600 };
const section = { margin: "0 0 24px" };
const count = { color: "#9ca3af", fontWeight: 400 };
const rowText = {
  fontSize: "13px",
  color: "#374151",
  lineHeight: "1.5",
  margin: "0 0 10px",
  paddingLeft: "12px",
  borderLeft: "2px solid #e5e7eb",
};
const rowWhen = {
  color: "#6b7280",
  fontSize: "11px",
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
};
const rowActor = { fontWeight: 600, color: "#0b1220" };
const hr = { borderColor: "#e5e7eb", margin: "28px 0" };
const footer = { fontSize: "12px", color: "#9ca3af", margin: 0 };
