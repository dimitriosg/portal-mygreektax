export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      activity_events: {
        Row: {
          actor_email: string | null;
          actor_name: string | null;
          actor_user_id: string | null;
          event_type: string;
          id: string;
          metadata: Json;
          occurred_at: string;
          subject_label: string | null;
        };
        Insert: {
          actor_email?: string | null;
          actor_name?: string | null;
          actor_user_id?: string | null;
          event_type: string;
          id?: string;
          metadata?: Json;
          occurred_at?: string;
          subject_label?: string | null;
        };
        Update: {
          actor_email?: string | null;
          actor_name?: string | null;
          actor_user_id?: string | null;
          event_type?: string;
          id?: string;
          metadata?: Json;
          occurred_at?: string;
          subject_label?: string | null;
        };
        Relationships: [];
      };
      client_token_events: {
        Row: {
          actor_email: string | null;
          actor_name: string | null;
          actor_user_id: string | null;
          event_type: string;
          id: string;
          metadata: Json;
          occurred_at: string;
          token: string;
        };
        Insert: {
          actor_email?: string | null;
          actor_name?: string | null;
          actor_user_id?: string | null;
          event_type: string;
          id?: string;
          metadata?: Json;
          occurred_at?: string;
          token: string;
        };
        Update: {
          actor_email?: string | null;
          actor_name?: string | null;
          actor_user_id?: string | null;
          event_type?: string;
          id?: string;
          metadata?: Json;
          occurred_at?: string;
          token?: string;
        };
        Relationships: [];
      };
      client_tokens: {
        Row: {
          airtable_client_id: string;
          airtable_job_id: string;
          client_email: string;
          created_at: string;
          created_by: string | null;
          expires_at: string;
          first_opened_at: string | null;
          last_country: string | null;
          last_ip: string | null;
          last_opened_at: string | null;
          last_user_agent: string | null;
          open_count: number;
          regenerated_from_token: string | null;
          revoked_at: string | null;
          token: string;
        };
        Insert: {
          airtable_client_id: string;
          airtable_job_id: string;
          client_email: string;
          created_at?: string;
          created_by?: string | null;
          expires_at: string;
          first_opened_at?: string | null;
          last_country?: string | null;
          last_ip?: string | null;
          last_opened_at?: string | null;
          last_user_agent?: string | null;
          open_count?: number;
          regenerated_from_token?: string | null;
          revoked_at?: string | null;
          token: string;
        };
        Update: {
          airtable_client_id?: string;
          airtable_job_id?: string;
          client_email?: string;
          created_at?: string;
          created_by?: string | null;
          expires_at?: string;
          first_opened_at?: string | null;
          last_country?: string | null;
          last_ip?: string | null;
          last_opened_at?: string | null;
          last_user_agent?: string | null;
          open_count?: number;
          regenerated_from_token?: string | null;
          revoked_at?: string | null;
          token?: string;
        };
        Relationships: [];
      };
      email_send_log: {
        Row: {
          created_at: string;
          error_message: string | null;
          id: string;
          message_id: string | null;
          metadata: Json | null;
          recipient_email: string;
          status: string;
          template_name: string;
        };
        Insert: {
          created_at?: string;
          error_message?: string | null;
          id?: string;
          message_id?: string | null;
          metadata?: Json | null;
          recipient_email: string;
          status: string;
          template_name: string;
        };
        Update: {
          created_at?: string;
          error_message?: string | null;
          id?: string;
          message_id?: string | null;
          metadata?: Json | null;
          recipient_email?: string;
          status?: string;
          template_name?: string;
        };
        Relationships: [];
      };
      email_send_state: {
        Row: {
          auth_email_ttl_minutes: number;
          batch_size: number;
          id: number;
          retry_after_until: string | null;
          send_delay_ms: number;
          transactional_email_ttl_minutes: number;
          updated_at: string;
        };
        Insert: {
          auth_email_ttl_minutes?: number;
          batch_size?: number;
          id?: number;
          retry_after_until?: string | null;
          send_delay_ms?: number;
          transactional_email_ttl_minutes?: number;
          updated_at?: string;
        };
        Update: {
          auth_email_ttl_minutes?: number;
          batch_size?: number;
          id?: number;
          retry_after_until?: string | null;
          send_delay_ms?: number;
          transactional_email_ttl_minutes?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      email_unsubscribe_tokens: {
        Row: {
          created_at: string;
          email: string;
          id: string;
          token: string;
          used_at: string | null;
        };
        Insert: {
          created_at?: string;
          email: string;
          id?: string;
          token: string;
          used_at?: string | null;
        };
        Update: {
          created_at?: string;
          email?: string;
          id?: string;
          token?: string;
          used_at?: string | null;
        };
        Relationships: [];
      };
      job_change_requests: {
        Row: {
          airtable_job_id: string;
          created_at: string;
          current_value: string | null;
          decided_at: string | null;
          decided_by: string | null;
          decision_note: string | null;
          field_name: string;
          id: string;
          job_code: string | null;
          reason: string | null;
          requested_by: string;
          requested_value: string | null;
          requester_email: string | null;
          requester_name: string | null;
          status: string;
        };
        Insert: {
          airtable_job_id: string;
          created_at?: string;
          current_value?: string | null;
          decided_at?: string | null;
          decided_by?: string | null;
          decision_note?: string | null;
          field_name: string;
          id?: string;
          job_code?: string | null;
          reason?: string | null;
          requested_by: string;
          requested_value?: string | null;
          requester_email?: string | null;
          requester_name?: string | null;
          status?: string;
        };
        Update: {
          airtable_job_id?: string;
          created_at?: string;
          current_value?: string | null;
          decided_at?: string | null;
          decided_by?: string | null;
          decision_note?: string | null;
          field_name?: string;
          id?: string;
          job_code?: string | null;
          reason?: string | null;
          requested_by?: string;
          requested_value?: string | null;
          requester_email?: string | null;
          requester_name?: string | null;
          status?: string;
        };
        Relationships: [];
      };
      job_events: {
        Row: {
          actor_email: string | null;
          actor_name: string | null;
          airtable_job_id: string;
          comment: string | null;
          created_at: string;
          event_type: string;
          from_status: string | null;
          id: string;
          impersonated_accountant_id: string | null;
          to_status: string | null;
          user_id: string;
        };
        Insert: {
          actor_email?: string | null;
          actor_name?: string | null;
          airtable_job_id: string;
          comment?: string | null;
          created_at?: string;
          event_type: string;
          from_status?: string | null;
          id?: string;
          impersonated_accountant_id?: string | null;
          to_status?: string | null;
          user_id: string;
        };
        Update: {
          actor_email?: string | null;
          actor_name?: string | null;
          airtable_job_id?: string;
          comment?: string | null;
          created_at?: string;
          event_type?: string;
          from_status?: string | null;
          id?: string;
          impersonated_accountant_id?: string | null;
          to_status?: string | null;
          user_id?: string;
        };
        Relationships: [];
      };
      job_order_preferences: {
        Row: {
          created_at: string;
          id: string;
          ordered_job_ids: string[];
          scope_key: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          ordered_job_ids?: string[];
          scope_key: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          ordered_job_ids?: string[];
          scope_key?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      partner_invites: {
        Row: {
          airtable_accountant_id: string | null;
          consumed_at: string | null;
          consumed_user_id: string | null;
          created_at: string;
          created_by: string;
          email: string;
          expires_at: string;
          first_name: string;
          id: string;
          last_name: string;
          token_hash: string;
        };
        Insert: {
          airtable_accountant_id?: string | null;
          consumed_at?: string | null;
          consumed_user_id?: string | null;
          created_at?: string;
          created_by: string;
          email: string;
          expires_at?: string;
          first_name: string;
          id?: string;
          last_name: string;
          token_hash: string;
        };
        Update: {
          airtable_accountant_id?: string | null;
          consumed_at?: string | null;
          consumed_user_id?: string | null;
          created_at?: string;
          created_by?: string;
          email?: string;
          expires_at?: string;
          first_name?: string;
          id?: string;
          last_name?: string;
          token_hash?: string;
        };
        Relationships: [];
      };
      partner_profiles: {
        Row: {
          airtable_accountant_id: string;
          created_at: string;
          disabled_at: string | null;
          disabled_by: string | null;
          email: string;
          full_name: string | null;
          user_id: string;
        };
        Insert: {
          airtable_accountant_id: string;
          created_at?: string;
          disabled_at?: string | null;
          disabled_by?: string | null;
          email: string;
          full_name?: string | null;
          user_id: string;
        };
        Update: {
          airtable_accountant_id?: string;
          created_at?: string;
          disabled_at?: string | null;
          disabled_by?: string | null;
          email?: string;
          full_name?: string | null;
          user_id?: string;
        };
        Relationships: [];
      };
      suppressed_emails: {
        Row: {
          created_at: string;
          email: string;
          id: string;
          metadata: Json | null;
          reason: string;
        };
        Insert: {
          created_at?: string;
          email: string;
          id?: string;
          metadata?: Json | null;
          reason: string;
        };
        Update: {
          created_at?: string;
          email?: string;
          id?: string;
          metadata?: Json | null;
          reason?: string;
        };
        Relationships: [];
      };
      tracking_link_opens: {
        Row: {
          airtable_job_id: string | null;
          browser: string | null;
          city: string | null;
          client_email: string | null;
          country: string | null;
          device: string | null;
          id: string;
          ip: string | null;
          opened_at: string;
          os: string | null;
          referrer: string | null;
          token: string;
          user_agent: string | null;
        };
        Insert: {
          airtable_job_id?: string | null;
          browser?: string | null;
          city?: string | null;
          client_email?: string | null;
          country?: string | null;
          device?: string | null;
          id?: string;
          ip?: string | null;
          opened_at?: string;
          os?: string | null;
          referrer?: string | null;
          token: string;
          user_agent?: string | null;
        };
        Update: {
          airtable_job_id?: string | null;
          browser?: string | null;
          city?: string | null;
          client_email?: string | null;
          country?: string | null;
          device?: string | null;
          id?: string;
          ip?: string | null;
          opened_at?: string;
          os?: string | null;
          referrer?: string | null;
          token?: string;
          user_agent?: string | null;
        };
        Relationships: [];
      };
      user_roles: {
        Row: {
          id: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Insert: {
          id?: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Update: {
          id?: string;
          role?: Database["public"]["Enums"]["app_role"];
          user_id?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      delete_email: {
        Args: { message_id: number; queue_name: string };
        Returns: boolean;
      };
      enqueue_email: {
        Args: { payload: Json; queue_name: string };
        Returns: number;
      };
      get_partner_last_seen: {
        Args: { _user_ids: string[] };
        Returns: {
          last_seen_at: string;
          user_id: string;
        }[];
      };
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"];
          _user_id: string;
        };
        Returns: boolean;
      };
      is_my_partner_profile: { Args: { _user_id: string }; Returns: boolean };
      move_to_dlq: {
        Args: {
          dlq_name: string;
          message_id: number;
          payload: Json;
          source_queue: string;
        };
        Returns: number;
      };
      read_email_batch: {
        Args: { batch_size: number; queue_name: string; vt: number };
        Returns: {
          message: Json;
          msg_id: number;
          read_ct: number;
        }[];
      };
    };
    Enums: {
      app_role: "admin" | "partner";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "partner"],
    },
  },
} as const;
