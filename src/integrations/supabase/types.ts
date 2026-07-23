export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      mentor_message_deliveries: {
        Row: {
          acknowledged_at: string | null;
          created_at: string;
          failure_count: number;
          fetch_count: number;
          first_fetched_at: string | null;
          last_error_code: string | null;
          last_fetched_at: string | null;
          message_id: string;
          session_id: string;
          student_id: string;
          updated_at: string;
          web_seen_at: string | null;
        };
        Insert: {
          acknowledged_at?: string | null;
          created_at?: string;
          failure_count?: number;
          fetch_count?: number;
          first_fetched_at?: string | null;
          last_error_code?: string | null;
          last_fetched_at?: string | null;
          message_id: string;
          session_id: string;
          student_id: string;
          updated_at?: string;
          web_seen_at?: string | null;
        };
        Update: {
          acknowledged_at?: string | null;
          created_at?: string;
          failure_count?: number;
          fetch_count?: number;
          first_fetched_at?: string | null;
          last_error_code?: string | null;
          last_fetched_at?: string | null;
          message_id?: string;
          session_id?: string;
          student_id?: string;
          updated_at?: string;
          web_seen_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "mentor_message_deliveries_message_session_fkey";
            columns: ["message_id", "session_id"];
            isOneToOne: true;
            referencedRelation: "timeline_items";
            referencedColumns: ["id", "session_id"];
          },
          {
            foreignKeyName: "mentor_message_deliveries_session_student_fkey";
            columns: ["session_id", "student_id"];
            isOneToOne: false;
            referencedRelation: "sessions";
            referencedColumns: ["id", "student_id"];
          },
          {
            foreignKeyName: "mentor_message_deliveries_student_id_fkey";
            columns: ["student_id"];
            isOneToOne: false;
            referencedRelation: "students";
            referencedColumns: ["id"];
          },
        ];
      };
      sessions: {
        Row: {
          created_at: string;
          id: string;
          last_severity: Database["public"]["Enums"]["severity"];
          session_group: Database["public"]["Enums"]["session_group"];
          session_title: string;
          source: string;
          source_session_key: string | null;
          student_id: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          last_severity?: Database["public"]["Enums"]["severity"];
          session_group?: Database["public"]["Enums"]["session_group"];
          session_title: string;
          source?: string;
          source_session_key?: string | null;
          student_id: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          last_severity?: Database["public"]["Enums"]["severity"];
          session_group?: Database["public"]["Enums"]["session_group"];
          session_title?: string;
          source?: string;
          source_session_key?: string | null;
          student_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "sessions_student_id_fkey";
            columns: ["student_id"];
            isOneToOne: false;
            referencedRelation: "students";
            referencedColumns: ["id"];
          },
        ];
      };
      staff_accounts: {
        Row: {
          active_operation_desired: boolean | null;
          active_operation_token: string | null;
          active_state_version: number;
          auth_identity_version: number;
          created_at: string;
          created_by: string | null;
          disabled_at: string | null;
          disabled_by: string | null;
          is_active: boolean;
          must_change_password: boolean;
          normalized_username: string;
          password_reset_operation_token: string | null;
          password_reset_previous_must_change: boolean | null;
          updated_at: string;
          user_id: string;
          username: string;
        };
        Insert: {
          active_operation_desired?: boolean | null;
          active_operation_token?: string | null;
          active_state_version?: number;
          auth_identity_version?: number;
          created_at?: string;
          created_by?: string | null;
          disabled_at?: string | null;
          disabled_by?: string | null;
          is_active?: boolean;
          must_change_password?: boolean;
          normalized_username: string;
          password_reset_operation_token?: string | null;
          password_reset_previous_must_change?: boolean | null;
          updated_at?: string;
          user_id: string;
          username: string;
        };
        Update: {
          active_operation_desired?: boolean | null;
          active_operation_token?: string | null;
          active_state_version?: number;
          auth_identity_version?: number;
          created_at?: string;
          created_by?: string | null;
          disabled_at?: string | null;
          disabled_by?: string | null;
          is_active?: boolean;
          must_change_password?: boolean;
          normalized_username?: string;
          password_reset_operation_token?: string | null;
          password_reset_previous_must_change?: boolean | null;
          updated_at?: string;
          user_id?: string;
          username?: string;
        };
        Relationships: [];
      };
      students: {
        Row: {
          created_at: string;
          display_name: string;
          id: string;
          last_active_at: string;
          last_severity: Database["public"]["Enums"]["severity"];
          updated_at: string;
          user_id: string | null;
          workbuddy_token: string;
        };
        Insert: {
          created_at?: string;
          display_name: string;
          id?: string;
          last_active_at?: string;
          last_severity?: Database["public"]["Enums"]["severity"];
          updated_at?: string;
          user_id?: string | null;
          workbuddy_token?: string;
        };
        Update: {
          created_at?: string;
          display_name?: string;
          id?: string;
          last_active_at?: string;
          last_severity?: Database["public"]["Enums"]["severity"];
          updated_at?: string;
          user_id?: string | null;
          workbuddy_token?: string;
        };
        Relationships: [];
      };
      timeline_items: {
        Row: {
          author_id: string | null;
          author_username: string | null;
          created_at: string;
          event_ordinal: number | null;
          id: string;
          kind: Database["public"]["Enums"]["timeline_kind"];
          session_id: string;
          severity: Database["public"]["Enums"]["severity"] | null;
          source_event_id: string | null;
          tag: string | null;
          text: string;
        };
        Insert: {
          author_id?: string | null;
          author_username?: string | null;
          created_at?: string;
          event_ordinal?: number | null;
          id?: string;
          kind: Database["public"]["Enums"]["timeline_kind"];
          session_id: string;
          severity?: Database["public"]["Enums"]["severity"] | null;
          source_event_id?: string | null;
          tag?: string | null;
          text: string;
        };
        Update: {
          author_id?: string | null;
          author_username?: string | null;
          created_at?: string;
          event_ordinal?: number | null;
          id?: string;
          kind?: Database["public"]["Enums"]["timeline_kind"];
          session_id?: string;
          severity?: Database["public"]["Enums"]["severity"] | null;
          source_event_id?: string | null;
          tag?: string | null;
          text?: string;
        };
        Relationships: [
          {
            foreignKeyName: "timeline_items_session_id_fkey";
            columns: ["session_id"];
            isOneToOne: false;
            referencedRelation: "sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "timeline_items_event_session_fkey";
            columns: ["source_event_id", "session_id"];
            isOneToOne: false;
            referencedRelation: "workbuddy_ingest_events";
            referencedColumns: ["event_id", "session_id"];
          },
        ];
      };
      user_roles: {
        Row: {
          created_at: string;
          id: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          role?: Database["public"]["Enums"]["app_role"];
          user_id?: string;
        };
        Relationships: [];
      };
      workbuddy_credentials: {
        Row: {
          created_at: string;
          id: string;
          last_used_at: string | null;
          revoked_at: string | null;
          source: string;
          status: string;
          student_id: string;
          token_hash: string;
          token_prefix: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          last_used_at?: string | null;
          revoked_at?: string | null;
          source?: string;
          status?: string;
          student_id: string;
          token_hash: string;
          token_prefix: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          last_used_at?: string | null;
          revoked_at?: string | null;
          source?: string;
          status?: string;
          student_id?: string;
          token_hash?: string;
          token_prefix?: string;
        };
        Relationships: [
          {
            foreignKeyName: "workbuddy_credentials_student_id_fkey";
            columns: ["student_id"];
            isOneToOne: false;
            referencedRelation: "students";
            referencedColumns: ["id"];
          },
        ];
      };
      workbuddy_ingest_events: {
        Row: {
          client_created_at: string;
          created_at: string;
          event_id: string;
          payload_sha256: string;
          result: Json;
          session_id: string | null;
          source: string;
          student_id: string;
        };
        Insert: {
          client_created_at: string;
          created_at?: string;
          event_id: string;
          payload_sha256: string;
          result?: Json;
          session_id?: string | null;
          source: string;
          student_id: string;
        };
        Update: {
          client_created_at?: string;
          created_at?: string;
          event_id?: string;
          payload_sha256?: string;
          result?: Json;
          session_id?: string | null;
          source?: string;
          student_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "workbuddy_ingest_events_session_student_fkey";
            columns: ["session_id", "student_id"];
            isOneToOne: false;
            referencedRelation: "sessions";
            referencedColumns: ["id", "student_id"];
          },
          {
            foreignKeyName: "workbuddy_ingest_events_student_id_fkey";
            columns: ["student_id"];
            isOneToOne: false;
            referencedRelation: "students";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      bootstrap_staff_account: {
        Args: {
          _auth_identity_version?: number;
          _is_team_admin?: boolean;
          _user_id: string;
          _username: string;
        };
        Returns: Json;
      };
      admin_begin_staff_active_operation: {
        Args: {
          _actor_user_id: string;
          _is_active: boolean;
          _operation_token: string;
          _target_user_id: string;
        };
        Returns: Json;
      };
      admin_begin_staff_password_reset: {
        Args: {
          _actor_user_id: string;
          _operation_token: string;
          _target_user_id: string;
        };
        Returns: Json;
      };
      admin_confirm_staff_active_sync: {
        Args: {
          _actor_user_id: string;
          _observed_version: number;
          _operation_token: string | null;
          _target_user_id: string;
        };
        Returns: Json;
      };
      admin_finish_staff_password_reset: {
        Args: {
          _actor_user_id: string;
          _operation_token: string;
          _succeeded: boolean;
          _target_user_id: string;
        };
        Returns: Json;
      };
      admin_get_staff_active_sync_state: {
        Args: {
          _actor_user_id: string;
          _target_user_id: string;
        };
        Returns: Json;
      };
      complete_staff_password_change: {
        Args: {
          _user_id: string;
        };
        Returns: boolean;
      };
      create_mentor_message: {
        Args: {
          _author_user_id: string;
          _session_id: string;
          _severity?: Database["public"]["Enums"]["severity"] | null;
          _student_id: string;
          _text: string;
        };
        Returns: Json;
      };
      get_my_legacy_workbuddy_setup: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      has_active_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"];
          _user_id: string;
        };
        Returns: boolean;
      };
      ingest_workbuddy_turn: {
        Args: {
          _client_created_at?: string | null;
          _diagnosis_severity?: Database["public"]["Enums"]["severity"] | null;
          _diagnosis_text?: string | null;
          _event_id: string;
          _payload_sha256: string;
          _prompt: string;
          _reply: string;
          _session_title: string;
          _source: string;
          _source_session_key: string;
          _student_id: string;
        };
        Returns: Json;
      };
      mark_mentor_messages_web_seen: {
        Args: {
          _message_ids: string[];
        };
        Returns: number;
      };
      provision_staff_account: {
        Args: {
          _auth_identity_version?: number;
          _created_by: string;
          _is_team_admin?: boolean;
          _user_id: string;
          _username: string;
        };
        Returns: Json;
      };
    };
    Enums: {
      app_role: "mentor" | "student" | "team_admin";
      session_group: "space" | "task";
      severity: "ok" | "warn" | "error";
      timeline_kind: "prompt" | "reply" | "diagnosis" | "mentor";
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
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
      app_role: ["mentor", "student", "team_admin"],
      session_group: ["space", "task"],
      severity: ["ok", "warn", "error"],
      timeline_kind: ["prompt", "reply", "diagnosis", "mentor"],
    },
  },
} as const;
