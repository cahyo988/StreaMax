const success = { description: "Request succeeded" };
const videoAccepted = {
  description: "Video registered; poll the library until ready or failed",
  content: {
    "application/json": { schema: { $ref: "#/components/schemas/Video" } },
  },
};
const errors = {
  "400": { description: "Invalid request" },
  "401": { description: "Authentication required" },
  "403": { description: "Insufficient permission or invalid CSRF/origin" },
  "404": { description: "Resource not found" },
  "409": { description: "Resource conflict" },
  "503": { description: "Workspace maintenance mode" },
};
const writeHeaders = [
  {
    in: "header",
    name: "Origin",
    required: true,
    schema: { type: "string", format: "uri" },
    description: "Must exactly match APP_ORIGIN.",
  },
  {
    in: "header",
    name: "X-CSRF-Token",
    required: true,
    schema: { type: "string" },
    description: "CSRF token returned by POST /login.",
  },
];
const idPathParameter = {
  in: "path",
  name: "id",
  required: true,
  schema: { type: "string", format: "uuid" },
};
function operation(
  summary: string,
  operationId: string,
  write = false,
  responseSchema = "Object",
) {
  return {
    summary,
    operationId,
    security: [{ sessionCookie: [] }, { bearerApiKey: [] }],
    ...(write ? { parameters: writeHeaders } : {}),
    responses: {
      "200": {
        description: success.description,
        content: {
          "application/json": {
            schema: { $ref: `#/components/schemas/${responseSchema}` },
          },
        },
      },
      ...errors,
    },
  };
}
function jsonWrite(
  summary: string,
  operationId: string,
  requestSchema: string,
) {
  return {
    ...operation(summary, operationId, true),
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: `#/components/schemas/${requestSchema}` },
        },
      },
    },
  };
}
const auditQueryParameters = [
  ...["actor", "action", "resource"].map((name) => ({
    in: "query",
    name,
    required: false,
    schema: { type: "string" },
  })),
  {
    in: "query",
    name: "result",
    required: false,
    schema: { type: "string", enum: ["success", "failure"] },
  },
  ...["from", "to"].map((name) => ({
    in: "query",
    name,
    required: false,
    schema: { type: "string", format: "date-time" },
  })),
  {
    in: "query",
    name: "limit",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 20000 },
  },
];
const resources = [
  "playlists",
  "profiles",
  "destinations",
  "streams",
  "schedules",
] as const;
const resourceInputSchemas: Record<(typeof resources)[number], string> = {
  playlists: "PlaylistInput",
  profiles: "ProfileInput",
  destinations: "DestinationInput",
  streams: "StreamInput",
  schedules: "ScheduleInput",
};
const resourcePaths = Object.fromEntries(
  resources.map((resource) => [
    `/${resource}`,
    {
      get: operation(
        `List ${resource}`,
        `list${resource}`,
        false,
        "EntityList",
      ),
      post: jsonWrite(
        `Create ${resource.slice(0, -1)}`,
        `create${resource}`,
        resourceInputSchemas[resource],
      ),
    },
  ]),
);
const resourceItemPaths = Object.fromEntries(
  resources.map((resource) => [
    `/${resource}/{id}`,
    {
      put: {
        ...jsonWrite(
          `Replace ${resource.slice(0, -1)}`,
          `replace${resource}`,
          resourceInputSchemas[resource],
        ),
        parameters: [...writeHeaders, idPathParameter],
      },
      delete: {
        ...operation(
          `Delete ${resource.slice(0, -1)}`,
          `delete${resource}`,
          true,
        ),
        parameters: [...writeHeaders, idPathParameter],
      },
    },
  ]),
);

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "StreaMax API",
    version: "0.1.0",
    description:
      "Authenticated single-workspace control API. Browser mutations require the session cookie, matching Origin, and X-CSRF-Token. Destinations use encrypted server-side stream keys; secrets are never returned.",
  },
  servers: [{ url: "/api" }],
  tags: [
    { name: "Session" },
    { name: "Workspace" },
    { name: "Media" },
    { name: "Broadcast" },
    { name: "Operations" },
    { name: "Documentation" },
  ],
  paths: {
    "/health": {
      get: {
        summary: "Public liveness and application name",
        operationId: "health",
        responses: {
          "200": {
            description: "Application is responding",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Health" },
              },
            },
          },
        },
      },
    },
    "/openapi.json": {
      get: operation(
        "Get this OpenAPI document",
        "getOpenApiDocument",
        false,
        "OpenApiDocument",
      ),
    },
    "/login": {
      post: {
        summary: "Create a browser session",
        operationId: "login",
        parameters: [
          {
            in: "header",
            name: "Origin",
            required: true,
            schema: { type: "string", format: "uri" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/LoginRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Session cookie set; CSRF token returned",
            headers: {
              "Set-Cookie": {
                schema: { type: "string" },
                description: "HTTP-only session cookie.",
              },
            },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Session" },
              },
            },
          },
          "400": errors["400"],
          "401": { description: "Invalid credentials" },
          "429": { description: "Login rate limit exceeded" },
        },
      },
    },
    "/me": { get: operation("Get current session", "getMe", false, "Session") },
    "/logout": {
      post: operation("End current session", "logout", true),
    },
    "/password": {
      post: {
        ...operation("Change own password", "changePassword", true),
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PasswordChange" },
            },
          },
        },
      },
    },
    "/settings": {
      get: operation("Read system settings", "getSettings", false, "Settings"),
      put: jsonWrite(
        "Update system settings (admin only)",
        "updateSettings",
        "SettingsInput",
      ),
    },
    "/branding/logo": {
      get: {
        ...operation("Get the public workspace logo", "getWorkspaceLogo"),
        security: [],
        responses: {
          "200": {
            description: "Workspace logo PNG",
            content: {
              "image/png": { schema: { type: "string", format: "binary" } },
            },
          },
          ...errors,
        },
      },
      put: {
        ...operation(
          "Upload a workspace logo PNG (admin only)",
          "uploadWorkspaceLogo",
          true,
        ),
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["file"],
                properties: { file: { type: "string", format: "binary" } },
              },
            },
          },
        },
      },
      delete: operation(
        "Remove the workspace logo (admin only)",
        "removeWorkspaceLogo",
        true,
      ),
    },
    "/backups": {
      get: operation(
        "List available offline backup archives (admin only)",
        "listBackups",
      ),
    },
    "/backups/{name}": {
      get: {
        ...operation(
          "Download an offline backup archive (admin only)",
          "downloadBackup",
        ),
        parameters: [
          {
            in: "path",
            name: "name",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Protected StreaMax backup archive",
            content: {
              "application/gzip": {
                schema: { type: "string", format: "binary" },
              },
            },
          },
          ...errors,
        },
      },
    },
    "/notifications": {
      get: operation(
        "Read notification settings",
        "getNotifications",
        false,
        "NotificationSettings",
      ),
      put: jsonWrite(
        "Update notification settings (admin only)",
        "updateNotifications",
        "NotificationSettingsInput",
      ),
    },
    "/notifications/test": {
      post: operation(
        "Send a test notification (admin only)",
        "testNotification",
        true,
      ),
    },
    "/webhooks": {
      get: operation(
        "Read signed outbound webhook settings (admin only)",
        "getWebhooks",
        false,
        "WebhookSettings",
      ),
      put: jsonWrite(
        "Update signed outbound webhook settings (admin only)",
        "updateWebhooks",
        "WebhookSettingsInput",
      ),
    },
    "/webhooks/test": {
      post: operation(
        "Send a signed webhook test event (admin only)",
        "testWebhooks",
        true,
      ),
    },
    "/users": {
      get: operation(
        "List team members (admin only)",
        "listUsers",
        false,
        "EntityList",
      ),
      post: jsonWrite(
        "Create a team member (admin only)",
        "createUser",
        "CreateUserInput",
      ),
    },
    "/users/{id}": {
      patch: {
        ...jsonWrite(
          "Activate or deactivate a team member (admin only)",
          "updateUserStatus",
          "UpdateUserInput",
        ),
        parameters: [...writeHeaders, idPathParameter],
      },
    },
    "/developer-keys": {
      get: {
        ...operation(
          "List issued developer API keys (admin only)",
          "listDeveloperKeys",
          false,
          "EntityList",
        ),
        security: [{ sessionCookie: [] }],
      },
      post: {
        ...jsonWrite(
          "Create a developer API key (admin only)",
          "createDeveloperKey",
          "DeveloperKeyInput",
        ),
        security: [{ sessionCookie: [] }],
      },
    },
    "/developer-keys/{id}": {
      delete: {
        ...operation(
          "Revoke a developer API key (admin only)",
          "revokeDeveloperKey",
          true,
        ),
        security: [{ sessionCookie: [] }],
        parameters: [...writeHeaders, idPathParameter],
      },
    },
    ...resourcePaths,
    ...resourceItemPaths,
    "/destinations/{id}/enabled": {
      patch: {
        ...jsonWrite(
          "Enable or disable a destination when it is not in use",
          "setDestinationEnabled",
          "DestinationEnabledInput",
        ),
        parameters: [...writeHeaders, idPathParameter],
      },
    },
    "/destinations/{id}/test": {
      post: {
        ...operation(
          "Probe TCP/TLS reachability without sending the stream key (admin only)",
          "testDestinationConnection",
          true,
          "Object",
        ),
        parameters: [...writeHeaders, idPathParameter],
      },
    },
    "/videos": {
      get: operation(
        "List video library and processing status",
        "listVideos",
        false,
        "VideoList",
      ),
      post: {
        ...operation("Upload and queue video processing", "uploadVideo", true),
        responses: {
          "201": videoAccepted,
          ...errors,
          "413": { description: "Upload size limit exceeded" },
          "507": { description: "Insufficient disk space" },
        },
        description:
          "Returns the video entity with status queued, processing, ready or failed. Poll GET /videos for completion; only ready videos can be played.",
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["file"],
                properties: {
                  file: { type: "string", format: "binary" },
                },
              },
            },
          },
        },
      },
    },
    "/videos/{id}": {
      delete: {
        ...operation("Delete an unreferenced video", "deleteVideo", true),
        parameters: [...writeHeaders, idPathParameter],
      },
    },
    "/uploads": {
      get: operation(
        "List the current user's resumable upload sessions",
        "listUploads",
      ),
      post: jsonWrite(
        "Create a resumable upload session",
        "createUpload",
        "UploadSessionInput",
      ),
    },
    "/uploads/{id}": {
      patch: {
        ...operation(
          "Append a binary upload chunk using Upload-Offset",
          "appendUploadChunk",
          true,
        ),
        parameters: [
          ...writeHeaders,
          idPathParameter,
          {
            in: "header",
            name: "Upload-Offset",
            required: true,
            schema: { type: "integer", minimum: 0 },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/octet-stream": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
      },
      delete: {
        ...operation("Cancel a resumable upload", "cancelUpload", true),
        parameters: [...writeHeaders, idPathParameter],
      },
    },
    "/uploads/{id}/complete": {
      post: {
        ...operation(
          "Validate and register a completed upload for processing",
          "completeUpload",
          true,
        ),
        responses: {
          "201": videoAccepted,
          ...errors,
          "507": { description: "Insufficient disk space" },
        },
        description:
          "Returns the video entity directly (including id and status). Transcoding runs in the background. Poll GET /videos for queued/processing/ready/failed status.",
        parameters: [...writeHeaders, idPathParameter],
      },
    },
    "/diagnostics": {
      get: operation(
        "Check runtime, storage, FFmpeg, browser origin and server port",
        "getDiagnostics",
      ),
    },
    "/preview/{id}/{file}": {
      get: {
        ...operation(
          "Read an authenticated live HLS encoder preview",
          "getLivePreview",
        ),
        parameters: [
          idPathParameter,
          {
            in: "path",
            name: "file",
            required: true,
            schema: { type: "string" },
          },
        ],
      },
    },
    "/media/{id}": {
      get: {
        ...operation("Stream authenticated video preview", "getMedia"),
        parameters: [
          {
            in: "path",
            name: "id",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
          {
            in: "header",
            name: "Range",
            required: false,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "MP4 media bytes" },
          "206": { description: "Requested media byte range" },
          "401": errors["401"],
          "404": errors["404"],
        },
      },
    },
    "/streams/{id}/{action}": {
      post: {
        ...operation("Start, stop, or restart a stream", "controlStream", true),
        parameters: [
          ...writeHeaders,
          {
            in: "path",
            name: "id",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
          {
            in: "path",
            name: "action",
            required: true,
            schema: { type: "string", enum: ["start", "stop", "restart"] },
          },
        ],
      },
    },
    "/overview": {
      get: operation(
        "Read worker and host overview",
        "getOverview",
        false,
        "Object",
      ),
    },
    "/events": {
      get: {
        ...operation(
          "Query latest audit events",
          "listEvents",
          false,
          "AuditEventList",
        ),
        parameters: auditQueryParameters,
      },
    },
    "/events/integrity": {
      get: operation(
        "Verify the retained audit chain and signed checkpoint (admin only)",
        "verifyEventIntegrity",
        false,
        "AuditIntegrity",
      ),
    },
    "/events.csv": {
      get: {
        ...operation("Export filtered audit events as CSV", "exportEventsCsv"),
        parameters: auditQueryParameters,
        responses: {
          "200": {
            description:
              "CSV attachment of matching retained events, including previous and current HMAC chain hashes",
            content: { "text/csv": { schema: { type: "string" } } },
          },
          ...errors,
        },
      },
    },
    "/analytics": {
      get: {
        ...operation("Read stream and destination analytics", "getAnalytics"),
        parameters: [
          ...["from", "to"].map((name) => ({
            in: "query",
            name,
            required: true,
            schema: { type: "string", format: "date-time" },
          })),
        ],
      },
    },
    "/analytics.csv": {
      get: {
        ...operation("Export session report as CSV", "exportAnalyticsCsv"),
        parameters: [
          ...["from", "to"].map((name) => ({
            in: "query",
            name,
            required: true,
            schema: { type: "string", format: "date-time" },
          })),
        ],
        responses: {
          "200": {
            description: "CSV attachment of stream sessions",
            content: { "text/csv": { schema: { type: "string" } } },
          },
          ...errors,
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerApiKey: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "StreaMax API key",
        description:
          "Admin-issued key with read/write permissions and optional expiration. The secret is shown only once.",
      },
      sessionCookie: {
        type: "apiKey",
        in: "cookie",
        name: "session",
        description: "HTTP-only session cookie set by POST /login.",
      },
    },
    schemas: {
      Object: { type: "object", additionalProperties: true },
      PlaylistInput: {
        type: "object",
        required: ["name", "videoIds"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 120 },
          videoIds: {
            type: "array",
            minItems: 1,
            maxItems: 500,
            items: { type: "string", format: "uuid" },
          },
        },
      },
      ProfileInput: {
        type: "object",
        required: ["name", "width", "height", "fps", "bitrate", "audioBitrate"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 120 },
          width: {
            type: "integer",
            minimum: 320,
            maximum: 1920,
            multipleOf: 2,
          },
          height: {
            type: "integer",
            minimum: 240,
            maximum: 1080,
            multipleOf: 2,
          },
          fps: { type: "integer", minimum: 15, maximum: 60 },
          bitrate: { type: "integer", minimum: 300, maximum: 12000 },
          audioBitrate: { type: "integer", minimum: 64, maximum: 320 },
        },
      },
      DestinationInput: {
        type: "object",
        required: ["name", "platform", "url"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 120 },
          platform: {
            type: "string",
            enum: ["YouTube", "Facebook", "Twitch", "Custom"],
          },
          url: {
            type: "string",
            format: "uri",
            maxLength: 500,
            description:
              "RTMP(S) ingest URL without username, password, query, or fragment.",
          },
          key: {
            type: "string",
            minLength: 1,
            maxLength: 500,
            description:
              "Required on create, optional on update to preserve the stored key.",
          },
          enabled: { type: "boolean", default: true },
        },
      },
      DestinationEnabledInput: {
        type: "object",
        required: ["enabled"],
        properties: { enabled: { type: "boolean" } },
      },
      StreamInput: {
        type: "object",
        required: ["name", "playlistId", "profileId", "destinationIds"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 120 },
          playlistId: { type: "string", format: "uuid" },
          profileId: { type: "string", format: "uuid" },
          destinationIds: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            uniqueItems: true,
            items: { type: "string", format: "uuid" },
          },
          loop: { type: "boolean", default: true },
          playCount: {
            type: "integer",
            minimum: 2,
            maximum: 1000,
            description:
              "Total plays, including the first playback; only for one-video playlists and mutually exclusive with loop.",
          },
          overlayText: { type: "string", maxLength: 200 },
          watermark: { type: "boolean" },
          overlayPosition: {
            type: "string",
            enum: ["top-left", "top-right", "bottom-left", "bottom-right"],
          },
          livePreview: {
            type: "boolean",
            description: "Uses one additional FFmpeg output slot.",
          },
        },
      },
      ScheduleInput: {
        type: "object",
        required: ["name", "streamId", "startAt", "endAt"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 120 },
          streamId: { type: "string", format: "uuid" },
          startAt: { type: "string", format: "date-time" },
          endAt: { type: "string", format: "date-time" },
          playlistId: {
            type: "string",
            format: "uuid",
            description: "Optional schedule-specific playlist.",
          },
          recurrence: {
            type: "string",
            enum: ["none", "daily", "weekly"],
            default: "none",
          },
          occurrences: {
            type: "integer",
            minimum: 1,
            maximum: 366,
            default: 1,
          },
        },
      },
      UploadSessionInput: {
        type: "object",
        required: ["name", "size", "fingerprint"],
        properties: {
          name: { type: "string", maxLength: 120 },
          size: { type: "integer", minimum: 1 },
          fingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
        },
      },
      SettingsInput: {
        type: "object",
        required: [
          "applicationName",
          "maintenanceMode",
          "defaultProfileId",
          "defaultBitrate",
          "retryAttempts",
          "videoRetentionDays",
          "timeZone",
        ],
        properties: {
          applicationName: { type: "string", minLength: 1, maxLength: 120 },
          maintenanceMode: { type: "boolean" },
          defaultProfileId: { type: "string", maxLength: 64 },
          defaultBitrate: { type: "integer", minimum: 300, maximum: 12000 },
          retryAttempts: { type: "integer", minimum: 0, maximum: 10 },
          videoRetentionDays: { type: "integer", minimum: 0, maximum: 3650 },
          timeZone: { type: "string", minLength: 1, maxLength: 100 },
          thresholdAlerts: { type: "boolean", default: false },
          cpuThreshold: { type: "integer", minimum: 10, maximum: 100 },
          diskThreshold: { type: "integer", minimum: 10, maximum: 100 },
        },
      },
      NotificationSettingsInput: {
        type: "object",
        required: ["provider", "enabled", "events"],
        properties: {
          provider: { type: "string", enum: ["discord", "telegram"] },
          target: { type: "string", maxLength: 128, default: "" },
          secret: { type: "string", maxLength: 300 },
          enabled: { type: "boolean" },
          events: {
            type: "array",
            maxItems: 7,
            items: {
              type: "string",
              enum: [
                "stream.started",
                "stream.stopped",
                "stream.failed",
                "output.retrying",
                "schedule.failed",
                "system.threshold",
                "stream.stalled",
              ],
            },
          },
        },
      },
      WebhookSettingsInput: {
        type: "object",
        required: ["enabled", "events"],
        properties: {
          endpoint: {
            type: "string",
            format: "uri",
            maxLength: 2048,
            description:
              "HTTPS endpoint on a public address; endpoint secrets in query strings are not allowed.",
          },
          secret: {
            type: "string",
            minLength: 16,
            maxLength: 256,
            description:
              "HMAC-SHA256 signing secret; optional on update to preserve the saved secret.",
          },
          enabled: { type: "boolean" },
          events: {
            type: "array",
            uniqueItems: true,
            maxItems: 7,
            items: {
              type: "string",
              enum: [
                "stream.started",
                "stream.stopped",
                "stream.failed",
                "schedule.started",
                "schedule.failed",
              ],
            },
          },
        },
      },
      CreateUserInput: {
        type: "object",
        required: ["email", "password", "role"],
        properties: {
          email: { type: "string", format: "email" },
          password: { type: "string", minLength: 12, maxLength: 256 },
          role: { type: "string", enum: ["admin", "operator", "viewer"] },
        },
      },
      UpdateUserInput: {
        type: "object",
        required: ["active"],
        properties: { active: { type: "boolean" } },
      },
      DeveloperKeyInput: {
        type: "object",
        required: ["name", "permissions"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 120 },
          permissions: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string", enum: ["read", "write"] },
          },
          expiresAt: {
            type: "string",
            format: "date-time",
            description: "Optional; must be within the next 365 days.",
          },
        },
      },
      EntityList: {
        type: "array",
        items: { $ref: "#/components/schemas/Object" },
      },
      Video: {
        type: "object",
        required: ["id", "name", "status"],
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          status: {
            type: "string",
            enum: ["queued", "processing", "ready", "failed"],
          },
          processingProgress: {
            type: "integer",
            minimum: 0,
            maximum: 100,
            description:
              "Processing percentage; 100 only after successful finalization",
          },
          error: { type: "string" },
          transcoded: { type: "boolean" },
        },
        additionalProperties: true,
      },
      VideoList: {
        type: "array",
        items: { $ref: "#/components/schemas/Video" },
      },
      AuditEventList: {
        type: "array",
        items: {
          type: "object",
          required: [
            "id",
            "time",
            "actor",
            "action",
            "resource",
            "result",
            "metadata",
          ],
          properties: {
            id: { type: "integer" },
            time: { type: "string", format: "date-time" },
            actor: { type: "string" },
            action: { type: "string" },
            resource: { type: "string" },
            ip: { type: "string" },
            message: { type: "string" },
            previousHash: { type: "string", pattern: "^[a-f0-9]*$" },
            hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
            result: { type: "string", enum: ["success", "failure"] },
            metadata: { type: "object", additionalProperties: true },
          },
        },
      },
      AuditIntegrity: {
        type: "object",
        required: ["valid", "checked", "firstId", "lastId", "reason"],
        properties: {
          valid: { type: "boolean" },
          checked: { type: "integer", minimum: 0 },
          firstId: { type: ["integer", "null"] },
          lastId: { type: ["integer", "null"] },
          reason: { type: ["string", "null"] },
        },
      },
      Session: {
        type: "object",
        required: ["id", "email", "role", "csrf"],
        properties: {
          id: { type: "string", format: "uuid" },
          email: { type: "string", format: "email" },
          role: { type: "string", enum: ["admin", "operator", "viewer"] },
          csrf: { type: "string" },
        },
      },
      LoginRequest: {
        type: "object",
        required: ["email", "password"],
        properties: {
          email: { type: "string", format: "email" },
          password: { type: "string" },
          remember: { type: "boolean", default: false },
        },
      },
      PasswordChange: {
        type: "object",
        required: ["currentPassword", "password"],
        properties: {
          currentPassword: { type: "string" },
          password: { type: "string", minLength: 12, maxLength: 256 },
        },
      },
      Settings: {
        type: "object",
        properties: {
          applicationName: { type: "string" },
          maintenanceMode: { type: "boolean" },
          defaultProfileId: { type: "string", format: "uuid" },
          defaultBitrate: { type: "integer" },
          retryAttempts: { type: "integer", minimum: 0, maximum: 10 },
          videoRetentionDays: { type: "integer", minimum: 0, maximum: 3650 },
          timeZone: {
            type: "string",
            description: "IANA timezone identifier.",
          },
          thresholdAlerts: { type: "boolean" },
          cpuThreshold: { type: "integer" },
          diskThreshold: { type: "integer" },
        },
      },
      NotificationSettings: { type: "object", additionalProperties: true },
      WebhookSettings: { type: "object", additionalProperties: true },
      Health: {
        type: "object",
        required: ["status", "applicationName"],
        properties: {
          status: { type: "string", enum: ["ok"] },
          applicationName: { type: "string" },
        },
      },
      OpenApiDocument: { type: "object", additionalProperties: true },
    },
  },
} as const;

export function swaggerUiDocument(serverUrl = "/api", csrfToken?: string) {
  const document: any = structuredClone(openApiDocument);
  // Swagger UI's URL resolver expects an absolute scheme when executing
  // operations. Keep the downloadable contract portable and specialize only
  // the browser-facing copy using the current request origin.
  document.servers = [{ url: serverUrl }];
  document.info.description =
    "Interactive documentation uses your signed-in StreaMax browser session. Same-origin requests carry the session cookie and Origin header; the UI reads the CSRF token from this protected document before mutations.";
  if (csrfToken) document.info["x-csrf-token"] = csrfToken;
  for (const pathItem of Object.values(document.paths) as Array<
    Record<string, any>
  >) {
    for (const operation of Object.values(pathItem)) {
      if (!operation || typeof operation !== "object") continue;
      // The docs page is already session-protected. Browser cookies are sent
      // automatically, so Swagger UI must not ask for the HTTP-only cookie.
      operation.security = [];
      for (const parameter of operation.parameters || []) {
        if (parameter.in !== "header") continue;
        if (parameter.name.toLowerCase() === "origin") {
          parameter.required = false;
          parameter.description =
            "The browser supplies this automatically for same-origin mutations.";
        }
        if (parameter.name.toLowerCase() === "x-csrf-token") {
          parameter.required = false;
          parameter.description =
            "Automatically populated from the current session for Try it out.";
        }
      }
    }
  }
  return document;
}
