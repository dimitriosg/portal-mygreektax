import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Section,
  Text,
  Link,
} from "@react-email/components";
import type { TemplateEntry } from "./registry";

const SITE_NAME = "My Greek Tax";

const FIELD_LABELS: Record<string, string> = {
  sla_deadline: "SLA deadline",
  status: "Status",
  notes: "Notes",
};

export interface AdminProps {
  partnerName?: string;
  jobCode?: string;
  field?: string;
  currentValue?: string;
  requestedValue?: string;
  reason?: string | null;
  reviewUrl?: string;
}

const AdminEmail = ({
  partnerName,
  jobCode,
  field,
  currentValue,
  requestedValue,
  reason,
  reviewUrl,
}: AdminProps) => (
  <Html lang="en">
    <Head />
    <Preview>{`${partnerName ?? ""} requests a change to ${jobCode ?? ""}`}</Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>{`Change request — ${jobCode ?? ""}`}</Heading>
        <Text style={text}>
          <strong>{partnerName}</strong> requests an update to{" "}
          <strong>{FIELD_LABELS[field ?? ""] ?? field}</strong>.
        </Text>
        <Section style={box}>
          <Text style={small}><strong>Current:</strong> {currentValue || "—"}</Text>
          <Text style={small}><strong>Requested:</strong> {requestedValue || "—"}</Text>
          {reason ? <Text style={small}><strong>Reason:</strong> {reason}</Text> : null}
        </Section>
        {reviewUrl ? (
          <Text style={text}>
            <Link href={reviewUrl} style={link}>Review in admin →</Link>
          </Text>
        ) : null}
      </Container>
    </Body>
  </Html>
);

export const adminTemplate = {
  component: AdminEmail,
  subject: (d: Record<string, any>) =>
    `Change request: ${d.jobCode ?? "job"} (${FIELD_LABELS[d.field] ?? d.field ?? "field"})`,
  displayName: "Change request — admin",
  previewData: {
    partnerName: "Alex",
    jobCode: "JB123",
    field: "sla_deadline",
    currentValue: "2026-05-30",
    requestedValue: "2026-06-15",
    reason: "Client provided documents late.",
    reviewUrl: "https://portal.mygreektax.eu/admin/change-requests",
  },
} satisfies TemplateEntry;

export interface DecisionProps {
  partnerName?: string;
  jobCode?: string;
  field?: string;
  requestedValue?: string;
  decision?: "approved" | "rejected";
  decisionNote?: string | null;
  jobUrl?: string;
}

const DecisionEmail = ({
  partnerName,
  jobCode,
  field,
  requestedValue,
  decision,
  decisionNote,
  jobUrl,
}: DecisionProps) => (
  <Html lang="en">
    <Head />
    <Preview>{`Your change request for ${jobCode ?? ""} was ${decision ?? ""}`}</Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>{`Request ${decision ?? ""} — ${jobCode ?? ""}`}</Heading>
        <Text style={text}>
          Hi {partnerName ?? "there"}, your change request for{" "}
          <strong>{FIELD_LABELS[field ?? ""] ?? field}</strong> on{" "}
          <strong>{jobCode}</strong> was{" "}
          <strong>{decision === "approved" ? "approved" : "rejected"}</strong>.
        </Text>
        {decision === "approved" ? (
          <Section style={box}>
            <Text style={small}><strong>New value:</strong> {requestedValue || "—"}</Text>
          </Section>
        ) : null}
        {decisionNote ? (
          <Section style={box}>
            <Text style={small}><strong>Admin note:</strong> {decisionNote}</Text>
          </Section>
        ) : null}
        {jobUrl ? (
          <Text style={text}>
            <Link href={jobUrl} style={link}>Open job →</Link>
          </Text>
        ) : null}
      </Container>
    </Body>
  </Html>
);

export const decisionTemplate = {
  component: DecisionEmail,
  subject: (d: Record<string, any>) =>
    `Change request ${d.decision ?? "decided"}: ${d.jobCode ?? "job"}`,
  displayName: "Change request — decision",
  previewData: {
    partnerName: "Alex",
    jobCode: "JB123",
    field: "sla_deadline",
    requestedValue: "2026-06-15",
    decision: "approved",
    decisionNote: "Looks reasonable.",
    jobUrl: "https://portal.mygreektax.eu/jobs/recXXX",
  },
} satisfies TemplateEntry;

const main = { backgroundColor: "#ffffff", fontFamily: "Arial, sans-serif" };
const container = { padding: "32px 28px", maxWidth: "560px" };
const h1 = { fontSize: "20px", fontWeight: 700, color: "#0b1220", margin: "0 0 16px" };
const text = { fontSize: "14px", color: "#374151", lineHeight: "1.6", margin: "0 0 16px" };
const small = { fontSize: "13px", color: "#374151", lineHeight: "1.5", margin: "0 0 6px" };
const box = { backgroundColor: "#f5f7fa", borderRadius: "8px", padding: "14px 16px", margin: "0 0 16px" };
const link = { color: "#0b1220", textDecoration: "underline" };

export const template = adminTemplate; // default export for registry symmetry