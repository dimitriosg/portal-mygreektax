import type { ComponentType } from "react";
import { template as partnerInvite } from "./partner-invite";
import { template as activitySummary } from "./activity-summary";

export type TemplateData = Record<string, unknown>;

export interface TemplateEntry {
  component: ComponentType<never>;
  subject: string | ((data: TemplateData) => string);
  displayName?: string;
  previewData?: TemplateData;
  /** Fixed recipient — overrides caller-provided recipientEmail when set. */
  to?: string;
}

/**
 * Template registry — maps template names to their React Email components.
 * Import and register new templates here after creating them in this directory.
 *
 * Example:
 *   import { template as welcomeTemplate } from './welcome'
 *   // then add to TEMPLATES: 'welcome': welcomeTemplate
 */
export const TEMPLATES: Record<string, TemplateEntry> = {
  "partner-invite": partnerInvite,
  "activity-summary": activitySummary,
};
