import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Text,
} from "@react-email/components";
import type { TemplateEntry } from "./registry";

const SITE_NAME = "My Greek Tax";

interface PartnerInviteProps {
  firstName?: string;
  inviteUrl?: string;
}

const PartnerInviteEmail = ({ firstName, inviteUrl }: PartnerInviteProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>You're invited to the {SITE_NAME} partner portal</Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>
          {firstName ? `Welcome, ${firstName}` : "You're invited"}
        </Heading>
        <Text style={text}>
          You've been invited to join the {SITE_NAME} partner portal. Use the
          link below to set your password and access your dashboard.
        </Text>
        <Button href={inviteUrl ?? "#"} style={button}>
          Accept invitation
        </Button>
        <Text style={small}>
          Or paste this link into your browser:
          <br />
          <Link href={inviteUrl ?? "#"} style={linkStyle}>
            {inviteUrl ?? ""}
          </Link>
        </Text>
        <Hr style={hr} />
        <Text style={footer}>
          This invitation expires in 7 days. If you didn't expect it, you can
          safely ignore this email.
        </Text>
      </Container>
    </Body>
  </Html>
);

export const template = {
  component: PartnerInviteEmail,
  subject: `You're invited to the ${SITE_NAME} partner portal`,
  displayName: "Partner invitation",
  previewData: {
    firstName: "Alex",
    inviteUrl: "https://portal.mygreektax.eu/invite/sample-token",
  },
} satisfies TemplateEntry;

const main = { backgroundColor: "#ffffff", fontFamily: "Arial, sans-serif" };
const container = { padding: "32px 28px", maxWidth: "560px" };
const h1 = { fontSize: "22px", fontWeight: 700, color: "#0b1220", margin: "0 0 16px" };
const text = { fontSize: "14px", color: "#374151", lineHeight: "1.6", margin: "0 0 20px" };
const button = {
  backgroundColor: "#0b1220",
  color: "#ffffff",
  padding: "12px 20px",
  borderRadius: "8px",
  fontSize: "14px",
  fontWeight: 600,
  textDecoration: "none",
  display: "inline-block",
};
const small = { fontSize: "12px", color: "#6b7280", lineHeight: "1.5", margin: "20px 0 0", wordBreak: "break-all" as const };
const linkStyle = { color: "#0b1220", textDecoration: "underline" };
const hr = { borderColor: "#e5e7eb", margin: "28px 0" };
const footer = { fontSize: "12px", color: "#9ca3af", margin: 0 };