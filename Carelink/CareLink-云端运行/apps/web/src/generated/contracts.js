// Generated from frozen contracts. Do not edit by hand.
export const actionRegistry = {
  "schemaVersion": 1,
  "updatedAt": "2026-08-13T12:15:00+10:00",
  "locale": "zh-CN",
  "canonicalStringFile": "STRING-CATALOG.zh-CN.json",
  "phases": [
    "initial",
    "loading",
    "success",
    "stable_error",
    "retry",
    "session_or_permission_loss",
    "empty",
    "destructive_confirm",
    "return"
  ],
  "phaseKeyPattern": "actions.{actionId}.{phase}",
  "callerPhaseKeyPattern": "callerStrings.{actionId}.{caller}.{phase}",
  "stateLabelKeys": {
    "spaceLifecycle.active": "state.spaceLifecycle.active",
    "spaceLifecycle.archived": "state.spaceLifecycle.archived",
    "collectionState.open": "state.collectionState.open",
    "collectionState.paused": "state.collectionState.paused",
    "sharingState.private": "state.sharingState.private",
    "sharingState.shared": "state.sharingState.shared",
    "photoContentState.pending": "state.photoContentState.pending",
    "photoContentState.visible": "state.photoContentState.visible",
    "photoContentState.hidden": "state.photoContentState.hidden",
    "photoContentState.rejected": "state.photoContentState.rejected",
    "placementState.unavailable": "state.placementState.unavailable",
    "placementState.processing": "state.placementState.processing",
    "placementState.needs_confirmation": "state.placementState.needs_confirmation",
    "placementState.confirmed": "state.placementState.confirmed",
    "placementState.outside_scene": "state.placementState.outside_scene",
    "placementState.stale": "state.placementState.stale",
    "placementState.failed": "state.placementState.failed",
    "confirmationMode.auto": "state.confirmationMode.auto",
    "confirmationMode.manual": "state.confirmationMode.manual",
    "sceneReadiness.unavailable": "state.sceneReadiness.unavailable",
    "sceneReadiness.processing": "state.sceneReadiness.processing",
    "sceneReadiness.ready": "state.sceneReadiness.ready",
    "sceneReadiness.failed": "state.sceneReadiness.failed",
    "sceneMode.rotation360": "state.sceneMode.rotation360",
    "sceneMode.depth_limited_parallax": "state.sceneMode.depth_limited_parallax",
    "sceneMode.walkable3d": "state.sceneMode.walkable3d",
    "campaignStatus.active": "state.campaignStatus.active",
    "campaignStatus.paused": "state.campaignStatus.paused",
    "campaignStatus.revoked": "state.campaignStatus.revoked",
    "campaignStatus.expired": "state.campaignStatus.expired",
    "campaignStatus.exhausted": "state.campaignStatus.exhausted"
  },
  "decisionReasonLabelKeys": {
    "safety_hold": "decisionReason.safety_hold",
    "privacy_request": "decisionReason.privacy_request",
    "rights_concern": "decisionReason.rights_concern",
    "quality_or_duplicate": "decisionReason.quality_or_duplicate",
    "abusive_or_illegal": "decisionReason.abusive_or_illegal",
    "rights_violation": "decisionReason.rights_violation",
    "unrelated_content": "decisionReason.unrelated_content",
    "repeated_violation": "decisionReason.repeated_violation",
    "appeal_upheld": "decisionReason.appeal_upheld",
    "review_corrected": "decisionReason.review_corrected",
    "issue_resolved": "decisionReason.issue_resolved",
    "new_evidence": "decisionReason.new_evidence",
    "uploader_appeal": "decisionReason.uploader_appeal",
    "reviewer_correction": "decisionReason.reviewer_correction",
    "other": "decisionReason.other"
  },
  "contextLabelKeys": {
    "UPLOAD.OPEN.p08_new_batch": "contextLabels.UPLOAD.OPEN.p08_new_batch"
  },
  "contentTransitionContracts": {
    "CONTENT.APPROVE": {
      "transitionReasonCode": "manual_approved",
      "decisionReasonCode": null,
      "allowedDecisionReasonCodes": [],
      "noteRequiredWhenDecisionReasonCode": []
    },
    "CONTENT.HIDE": {
      "transitionReasonCode": "manual_hidden",
      "decisionReasonCode": "required_selection",
      "allowedDecisionReasonCodes": [
        "safety_hold",
        "privacy_request",
        "rights_concern",
        "quality_or_duplicate",
        "abusive_or_illegal",
        "rights_violation",
        "other"
      ],
      "noteRequiredWhenDecisionReasonCode": [
        "other"
      ]
    },
    "CONTENT.REJECT": {
      "transitionReasonCode": "manual_rejected",
      "decisionReasonCode": "required_selection",
      "allowedDecisionReasonCodes": [
        "abusive_or_illegal",
        "rights_violation",
        "unrelated_content",
        "repeated_violation",
        "rights_concern",
        "quality_or_duplicate",
        "other"
      ],
      "noteRequiredWhenDecisionReasonCode": [
        "other"
      ]
    },
    "CONTENT.RESTORE": {
      "transitionReasonCode": "manual_restored",
      "decisionReasonCode": "required_selection",
      "allowedDecisionReasonCodes": [
        "appeal_upheld",
        "review_corrected",
        "issue_resolved",
        "new_evidence",
        "other"
      ],
      "noteRequiredWhenDecisionReasonCode": [
        "other"
      ]
    },
    "CONTENT.REOPEN": {
      "transitionReasonCode": "manual_reopened",
      "decisionReasonCode": "required_selection",
      "allowedDecisionReasonCodes": [
        "uploader_appeal",
        "reviewer_correction",
        "new_evidence",
        "other"
      ],
      "noteRequiredWhenDecisionReasonCode": [
        "other"
      ]
    }
  },
  "actions": [
    {
      "id": "HOME.OPEN_SPACE",
      "route": "/",
      "returnTarget": "/",
      "entry": "P01",
      "actor": "any"
    },
    {
      "id": "AUTH.OPEN_LOGIN",
      "route": "/login",
      "returnTarget": "/spaces-or-requested-route",
      "entry": "P01,P02",
      "actor": "any-not-authenticated"
    },
    {
      "id": "AUTH.REQUEST_CODE",
      "route": "/login",
      "returnTarget": "requested-route",
      "entry": "P02",
      "actor": "anonymous"
    },
    {
      "id": "AUTH.VERIFY_CODE",
      "route": "/login",
      "returnTarget": "requested-route-or-/spaces",
      "entry": "P02",
      "actor": "anonymous"
    },
    {
      "id": "AUTH.LOGOUT",
      "route": "/account",
      "returnTarget": "/",
      "entry": "P18",
      "actor": "account"
    },
    {
      "id": "AUTH.LOGOUT_ALL",
      "route": "/account/sessions",
      "returnTarget": "/",
      "entry": "P18",
      "actor": "account-with-reauth"
    },
    {
      "id": "AUTH.REAUTH_REQUEST_CODE",
      "route": "/reauth",
      "returnTarget": "calling-route",
      "entry": "P03,P17,P18",
      "actor": "account"
    },
    {
      "id": "AUTH.REAUTHENTICATE",
      "route": "/reauth",
      "returnTarget": "calling-route",
      "entry": "P03,P17,P18",
      "actor": "account"
    },
    {
      "id": "MY_SPACES.OPEN",
      "route": "/spaces",
      "returnTarget": "/spaces",
      "entry": "P03",
      "actor": "account"
    },
    {
      "id": "MY_SPACES.OPEN_ARCHIVED",
      "route": "/spaces?filter=archived",
      "returnTarget": "/spaces",
      "entry": "P03",
      "actor": "owner"
    },
    {
      "id": "SPACE.OPEN_CREATE",
      "route": "/spaces/new",
      "returnTarget": "/spaces",
      "entry": "P03",
      "actor": "account",
      "kind": "navigation"
    },
    {
      "id": "SPACE.CREATE",
      "route": "/spaces/new",
      "returnTarget": "/manage/:spaceId?tab=setup",
      "entry": "P04",
      "actor": "account",
      "kind": "mutation",
      "method": "POST"
    },
    {
      "id": "SPACE.OPEN",
      "route": "/s/:spaceId",
      "returnTarget": "/spaces-or-/",
      "entry": "P03,session-reentry",
      "actor": "capability-projector",
      "successDestinations": [
        "album",
        "upload",
        "manage",
        "spaces"
      ],
      "fallbackOrder": [
        "view",
        "upload",
        "manage",
        "spaces"
      ],
      "managePredicate": "owner-or-any-active-management-scope"
    },
    {
      "id": "INVITATION.EXCHANGE",
      "route": "/open#invite=:secret",
      "returnTarget": "server-canonical-entryTask-route",
      "entry": "P05",
      "actor": "anonymous-per-access-bootstrap",
      "credentialSource": "derived-per-access-from-/open/{publicCampaignId}",
      "meter": "successful-entry-count-not-identified-guest-count"
    },
    {
      "id": "INVITATION.SCAN_AGAIN",
      "route": "/open",
      "returnTarget": "/",
      "entry": "P01,P05",
      "actor": "any"
    },
    {
      "id": "INVITATION.COPY_LINK",
      "route": "invitation-link-state",
      "returnTarget": "calling-invitation-page",
      "entry": "P16",
      "actor": "invitation-creator",
      "callerStringPath": "callerStrings.INVITATION.COPY_LINK.{caller}",
      "callerContracts": {
        "activity": {
          "source": "management-read-model",
          "redisplay": true,
          "urlTemplate": "/open/{publicCampaignId}"
        },
        "member": {
          "source": "create-response-memory-only",
          "redisplay": false,
          "urlTemplate": "/member-invitations/accept#invite=:secret"
        }
      }
    },
    {
      "id": "INVITATION.SHOW_QR",
      "route": "activity-invitation-management-read-model",
      "returnTarget": "calling-invitation-page",
      "entry": "P16",
      "actor": "member-with-canInvite-or-owner",
      "kind": "local",
      "encodes": "same-origin-/open/{publicCampaignId}-only",
      "networkRequests": 0,
      "payloadAnalytics": 0
    },
    {
      "id": "VIEW.OPEN_ALBUM",
      "route": "/s/:spaceId/album",
      "returnTarget": "/s/:spaceId",
      "entry": "P06",
      "actor": "effective-view"
    },
    {
      "id": "VIEW.OPEN_SCENE",
      "route": "/s/:spaceId/scene",
      "returnTarget": "/s/:spaceId/album",
      "entry": "P06,P06B,P14",
      "actor": "effective-view"
    },
    {
      "id": "PHOTO.OPEN_DETAIL",
      "route": "/s/:spaceId/photos/:photoId",
      "returnTarget": "album-scroll-anchor",
      "entry": "P06B",
      "actor": "effective-view"
    },
    {
      "id": "PHOTO.RETURN_TO_SCENE",
      "route": "/s/:spaceId/photos/:photoId",
      "returnTarget": "photo-detail",
      "entry": "P06B,P14",
      "actor": "effective-view"
    },
    {
      "id": "UPLOAD.ACCEPT_NOTICE",
      "route": "/s/:spaceId/upload",
      "returnTarget": "upload-selection",
      "entry": "P07",
      "actor": "effective-upload"
    },
    {
      "id": "UPLOAD.OPEN",
      "route": "/s/:spaceId/upload",
      "returnTarget": "calling-space-or-batch",
      "entry": "P06,P08",
      "actor": "effective-upload",
      "kind": "navigation"
    },
    {
      "id": "UPLOAD.SELECT_FILES",
      "route": "/s/:spaceId/upload",
      "returnTarget": "upload-selection",
      "entry": "P07",
      "actor": "current-consent-effective-upload",
      "kind": "mutation",
      "method": "POST"
    },
    {
      "id": "UPLOAD.REMOVE_ITEM",
      "route": "/s/:spaceId/upload",
      "returnTarget": "upload-selection",
      "entry": "P07",
      "actor": "open-batch-contributor-failed-item",
      "guard": "batch=open-and-item=failed"
    },
    {
      "id": "UPLOAD.RETRY_ITEM",
      "route": "/s/:spaceId/upload",
      "returnTarget": "upload-selection",
      "entry": "P07",
      "actor": "batch-contributor"
    },
    {
      "id": "UPLOAD.FINALIZE_BATCH",
      "route": "/s/:spaceId/upload",
      "returnTarget": "/uploads/:batchId",
      "entry": "P07",
      "actor": "batch-contributor"
    },
    {
      "id": "BATCH.OPEN_RESULT",
      "route": "/uploads/:batchId",
      "returnTarget": "space-or-/",
      "entry": "P08",
      "actor": "batch-session-or-bound-account"
    },
    {
      "id": "BATCH.OPEN_ITEM",
      "route": "/uploads/:batchId/items/:itemId",
      "returnTarget": "/uploads/:batchId",
      "entry": "P08,P09",
      "actor": "batch-session-or-bound-account"
    },
    {
      "id": "BATCH_RECEIPT.EXCHANGE",
      "route": "/uploads/open#receipt=:secret",
      "returnTarget": "/uploads/:batchId",
      "entry": "P08",
      "actor": "batch-receipt-secret"
    },
    {
      "id": "BATCH_BINDING.REQUEST_CODE",
      "route": "/uploads/:batchId/recovery",
      "returnTarget": "/uploads/:batchId",
      "entry": "P08",
      "actor": "batch-session"
    },
    {
      "id": "BATCH_BINDING.CONFIRM",
      "route": "/uploads/:batchId/recovery",
      "returnTarget": "/uploads/:batchId",
      "entry": "P08",
      "actor": "batch-session-with-code"
    },
    {
      "id": "BATCH.OPEN_ACCOUNT_UPLOADS",
      "route": "/account/uploads",
      "returnTarget": "/account",
      "entry": "P18",
      "actor": "account",
      "kind": "navigation"
    },
    {
      "id": "BATCH.RECOVER_FROM_ACCOUNT",
      "route": "/account/uploads/:batchId/recover",
      "returnTarget": "/uploads/:batchId",
      "entry": "P08,P18",
      "actor": "bound-account",
      "kind": "mutation"
    },
    {
      "id": "BATCH_RECEIPT.REVOKE",
      "route": "/uploads/:batchId/access",
      "returnTarget": "/account/uploads-or-/",
      "entry": "P08,P18",
      "actor": "batch-session"
    },
    {
      "id": "BATCH.DELETE_ITEM",
      "route": "/uploads/:batchId/photos/:photoId",
      "returnTarget": "/uploads/:batchId",
      "entry": "P08",
      "actor": "batch-session-or-owner"
    },
    {
      "id": "PLACEMENT.RETRY",
      "route": "/uploads/:batchId/photos/:photoId/placement",
      "returnTarget": "photo-result",
      "entry": "P09",
      "actor": "authorized-placement-editor"
    },
    {
      "id": "PLACEMENT.CONFIRM",
      "route": "/uploads/:batchId/photos/:photoId/placement",
      "returnTarget": "photo-result",
      "entry": "P09",
      "actor": "authorized-placement-editor"
    },
    {
      "id": "PLACEMENT.OPEN_EDITOR",
      "route": "/placements/:photoId/edit",
      "returnTarget": "calling-photo",
      "entry": "P09,P10",
      "actor": "authorized-placement-editor"
    },
    {
      "id": "PLACEMENT.SAVE",
      "route": "/placements/:photoId/edit",
      "returnTarget": "calling-photo",
      "entry": "P10",
      "actor": "authorized-placement-editor"
    },
    {
      "id": "PLACEMENT.UNDO",
      "route": "/placements/:photoId/history",
      "returnTarget": "calling-photo",
      "entry": "P10",
      "actor": "authorized-placement-editor"
    },
    {
      "id": "PLACEMENT.MARK_OUTSIDE",
      "route": "/placements/:photoId/edit",
      "returnTarget": "calling-photo",
      "entry": "P10,P12",
      "actor": "authorized-placement-editor"
    },
    {
      "id": "PLACEMENT.REOPEN_FOR_CONTRIBUTOR",
      "route": "/manage/:spaceId/placements/:photoId",
      "returnTarget": "placement-detail",
      "entry": "P10,P12",
      "actor": "owner"
    },
    {
      "id": "NOTE.OPT_IN",
      "route": "/experiments/scene-note/:photoId",
      "returnTarget": "photo-result",
      "entry": "P09B",
      "actor": "contributor"
    },
    {
      "id": "NOTE.CONFIRM",
      "route": "/experiments/scene-note/:photoId",
      "returnTarget": "photo-result",
      "entry": "P09B",
      "actor": "contributor"
    },
    {
      "id": "NOTE.WITHDRAW",
      "route": "/experiments/scene-note/:photoId",
      "returnTarget": "photo-result",
      "entry": "P09B",
      "actor": "contributor"
    },
    {
      "id": "MANAGE.OPEN",
      "route": "/manage/:spaceId",
      "returnTarget": "/spaces",
      "entry": "P11",
      "actor": "management-member-or-owner"
    },
    {
      "id": "MANAGE.OPEN_NEXT",
      "route": "/manage/:spaceId/next",
      "returnTarget": "/manage/:spaceId",
      "entry": "P11",
      "actor": "management-member-or-owner",
      "kind": "navigation",
      "targetSource": "server-current-management-read-model",
      "stableErrorCodes": [
        "concurrent_change"
      ]
    },
    {
      "id": "CONTENT.APPROVE",
      "route": "/manage/:spaceId/content/:photoId",
      "returnTarget": "moderation-queue",
      "entry": "P13",
      "actor": "member-with-canReview-or-owner"
    },
    {
      "id": "CONTENT.HIDE",
      "route": "/manage/:spaceId/content/:photoId",
      "returnTarget": "moderation-queue",
      "entry": "P13",
      "actor": "member-with-canReview-or-owner"
    },
    {
      "id": "CONTENT.REJECT",
      "route": "/manage/:spaceId/content/:photoId",
      "returnTarget": "moderation-queue",
      "entry": "P13",
      "actor": "member-with-canReview-or-owner"
    },
    {
      "id": "CONTENT.RESTORE",
      "route": "/manage/:spaceId/content/:photoId",
      "returnTarget": "moderation-queue",
      "entry": "P13",
      "actor": "member-with-canReview-or-owner"
    },
    {
      "id": "CONTENT.REOPEN",
      "route": "/manage/:spaceId/content/:photoId",
      "returnTarget": "moderation-queue",
      "entry": "P13",
      "actor": "member-with-canReview-or-owner"
    },
    {
      "id": "PANORAMA.UPLOAD_CANDIDATE",
      "route": "/manage/:spaceId/scene",
      "returnTarget": "scene-management",
      "entry": "P15",
      "actor": "member-with-canManageScene-or-owner"
    },
    {
      "id": "PANORAMA.SWITCH_CANDIDATE",
      "route": "/manage/:spaceId/scene",
      "returnTarget": "scene-management",
      "entry": "P15",
      "actor": "member-with-canManageScene-or-owner"
    },
    {
      "id": "PANORAMA.ROLLBACK",
      "route": "/manage/:spaceId/scene/history",
      "returnTarget": "scene-management",
      "entry": "P15",
      "actor": "member-with-canManageScene-or-owner"
    },
    {
      "id": "EXTERNAL_INVITATION.CREATE",
      "route": "/manage/:spaceId/invitations/external",
      "returnTarget": "activity-invitations",
      "entry": "P16",
      "actor": "member-with-canInvite-or-owner",
      "sharingModel": "multi-entrant-campaign-indirection",
      "inputs": [
        "taskMode",
        "entryTask",
        "expiresAt",
        "maxSuccessfulUses"
      ],
      "serverPolicyFields": [
        "maxPendingAdmissions",
        "ratePolicyVersion",
        "abusePolicyVersion"
      ]
    },
    {
      "id": "EXTERNAL_INVITATION.REVOKE",
      "route": "/manage/:spaceId/invitations/external/:invitationId",
      "returnTarget": "activity-invitations",
      "entry": "P16",
      "actor": "member-with-canInvite-or-owner"
    },
    {
      "id": "MEMBER_INVITATION.CREATE",
      "route": "/manage/:spaceId/members/invitations",
      "returnTarget": "members",
      "entry": "P16",
      "actor": "owner"
    },
    {
      "id": "MEMBER_INVITATION.ACCEPT",
      "route": "/member-invitations/accept#invite=:secret",
      "returnTarget": "/spaces",
      "entry": "P16",
      "actor": "account",
      "stableErrorCode": "member_invite_unavailable"
    },
    {
      "id": "MEMBER_INVITATION.REVOKE",
      "route": "/manage/:spaceId/members/invitations/:invitationId",
      "returnTarget": "members",
      "entry": "P16",
      "actor": "owner"
    },
    {
      "id": "MEMBERSHIP.UPDATE",
      "route": "/manage/:spaceId/members/:membershipId",
      "returnTarget": "members",
      "entry": "P16",
      "actor": "owner"
    },
    {
      "id": "MEMBERSHIP.REVOKE",
      "route": "/manage/:spaceId/members/:membershipId",
      "returnTarget": "members",
      "entry": "P16",
      "actor": "owner"
    },
    {
      "id": "COLLECTION.PAUSE",
      "route": "/manage/:spaceId/settings/collection",
      "returnTarget": "space-settings",
      "entry": "P17",
      "actor": "owner"
    },
    {
      "id": "COLLECTION.RESUME",
      "route": "/manage/:spaceId/settings/collection",
      "returnTarget": "space-settings",
      "entry": "P17",
      "actor": "owner"
    },
    {
      "id": "SHARING.ENABLE",
      "route": "/manage/:spaceId/settings/sharing",
      "returnTarget": "space-settings",
      "entry": "P17",
      "actor": "member-with-canPublish-or-owner"
    },
    {
      "id": "SHARING.DISABLE",
      "route": "/manage/:spaceId/settings/sharing",
      "returnTarget": "space-settings",
      "entry": "P17",
      "actor": "member-with-canPublish-or-owner"
    },
    {
      "id": "SPACE.ARCHIVE",
      "route": "/manage/:spaceId/settings",
      "returnTarget": "/spaces?filter=archived",
      "entry": "P17",
      "actor": "owner-with-reauth"
    },
    {
      "id": "SPACE.RESTORE",
      "route": "/spaces/:spaceId/archived",
      "returnTarget": "/spaces",
      "entry": "P17",
      "actor": "owner-with-reauth"
    },
    {
      "id": "SPACE.EXPORT",
      "route": "/spaces/:spaceId/export",
      "returnTarget": "/spaces/:spaceId/archived-or-/manage/:spaceId",
      "entry": "P17,P18",
      "actor": "owner"
    },
    {
      "id": "SPACE.DELETE_REQUEST",
      "route": "/spaces/:spaceId/delete",
      "returnTarget": "/spaces",
      "entry": "P17,P18",
      "actor": "owner-with-reauth"
    },
    {
      "id": "ACCOUNT.OPEN",
      "route": "/account",
      "returnTarget": "calling-route-or-/spaces",
      "entry": "P03,P18",
      "actor": "account"
    },
    {
      "id": "ACCOUNT.EXPORT",
      "route": "/account/export",
      "returnTarget": "/account",
      "entry": "P18",
      "actor": "account"
    },
    {
      "id": "ACCOUNT.DELETE_REQUEST",
      "route": "/account/delete",
      "returnTarget": "/",
      "entry": "P18",
      "actor": "account-with-reauth"
    },
    {
      "id": "OWNER_TRANSFER.CREATE",
      "route": "/spaces/:spaceId/owner-transfer",
      "returnTarget": "/account",
      "entry": "P18",
      "actor": "owner-with-reauth"
    },
    {
      "id": "OWNER_TRANSFER.ACCEPT",
      "route": "/spaces/pending-owner-transfers/:transferId",
      "returnTarget": "/spaces",
      "entry": "P03,P18",
      "actor": "target-active-member-account-with-reauth"
    },
    {
      "id": "OWNER_TRANSFER.REVOKE",
      "route": "/spaces/:spaceId/owner-transfer",
      "returnTarget": "/account",
      "entry": "P18",
      "actor": "current-owner"
    },
    {
      "id": "EXPORT.OPEN_STATUS",
      "route": "/exports/:exportId",
      "returnTarget": "calling-export-page",
      "entry": "P17,P18",
      "actor": "export-requester"
    },
    {
      "id": "EXPORT.DOWNLOAD",
      "route": "/exports/:exportId",
      "returnTarget": "calling-export-page",
      "entry": "P17,P18",
      "actor": "export-requester"
    },
    {
      "id": "DELETION.OPEN_STATUS",
      "route": "/deletions/:deletionId",
      "returnTarget": "calling-account-or-space-page",
      "entry": "P17,P18",
      "actor": "exact-deletion-status-session-or-live-space-photo-requester"
    },
    {
      "id": "REPORT.SUBMIT",
      "route": "/reports/new",
      "returnTarget": "reported-object-or-support",
      "entry": "P06B,P18",
      "actor": "valid-viewer-batch-or-account-session"
    },
    {
      "id": "REPORT.OPEN_STATUS",
      "route": "/reports/:reportNumber",
      "returnTarget": "/support",
      "entry": "P18",
      "actor": "reporter-session-or-account"
    },
    {
      "id": "APPEAL.SUBMIT",
      "route": "/appeals/new",
      "returnTarget": "photo-result-or-/support",
      "entry": "P08,P18",
      "actor": "affected-contributor-or-account"
    },
    {
      "id": "APPEAL.OPEN_STATUS",
      "route": "/appeals/:appealNumber",
      "returnTarget": "/support",
      "entry": "P18",
      "actor": "appellant-session-or-account"
    },
    {
      "id": "SUPPORT.OPEN",
      "route": "/support",
      "returnTarget": "calling-route-or-/",
      "entry": "P01,P06,P08,P18",
      "actor": "any"
    },
    {
      "id": "SUPPORT.SUBMIT_SAFETY_LEAD",
      "route": "/support/safety",
      "returnTarget": "/support",
      "entry": "P18",
      "actor": "any-no-object-context"
    },
    {
      "id": "SUPPORT.OPEN_STATUS",
      "route": "/support/cases/:caseId",
      "returnTarget": "/support",
      "entry": "P18",
      "actor": "case-session-or-account"
    },
    {
      "id": "MEDIA_NOTICE.OPEN",
      "route": "/notices/media",
      "returnTarget": "calling-upload-page",
      "entry": "P07",
      "actor": "effective-upload"
    },
    {
      "id": "LEGAL.OPEN_PRIVACY",
      "route": "/privacy",
      "returnTarget": "calling-route-or-/",
      "entry": "P01,P06,P08,P18",
      "actor": "any"
    },
    {
      "id": "LEGAL.OPEN_TERMS",
      "route": "/terms",
      "returnTarget": "calling-route-or-/",
      "entry": "P01,P06,P08,P18",
      "actor": "any"
    }
  ]
};
export const strings = {
  "schemaVersion": 1,
  "locale": "zh-CN",
  "updatedAt": "2026-08-13T12:56:00+10:00",
  "phaseOrder": [
    "initial",
    "loading",
    "success",
    "stable_error",
    "retry",
    "session_or_permission_loss",
    "empty",
    "destructive_confirm",
    "return"
  ],
  "stateLabels": {
    "state.spaceLifecycle.active": "使用中",
    "state.spaceLifecycle.archived": "已归档",
    "state.collectionState.open": "正在收集",
    "state.collectionState.paused": "已暂停收集",
    "state.sharingState.private": "未开启受邀查看",
    "state.sharingState.shared": "已开启受邀查看",
    "state.photoContentState.pending": "待审核",
    "state.photoContentState.visible": "可查看",
    "state.photoContentState.hidden": "已隐藏",
    "state.photoContentState.rejected": "未通过",
    "state.placementState.unavailable": "暂无位置",
    "state.placementState.processing": "正在定位",
    "state.placementState.needs_confirmation": "需要确认位置",
    "state.placementState.confirmed": "位置已确定",
    "state.placementState.outside_scene": "不属于这个现场",
    "state.placementState.stale": "位置需要更新",
    "state.placementState.failed": "定位失败",
    "state.confirmationMode.auto": "系统已定位",
    "state.confirmationMode.manual": "人工已确定",
    "state.sceneReadiness.unavailable": "暂无现场",
    "state.sceneReadiness.processing": "正在准备现场",
    "state.sceneReadiness.ready": "现场可用",
    "state.sceneReadiness.failed": "现场准备失败",
    "state.sceneMode.rotation360": "360°现场",
    "state.sceneMode.depth_limited_parallax": "有限视差实验",
    "state.sceneMode.walkable3d": "可导航3D",
    "state.campaignStatus.active": "使用中",
    "state.campaignStatus.paused": "已暂停",
    "state.campaignStatus.revoked": "已撤销",
    "state.campaignStatus.expired": "已到期",
    "state.campaignStatus.exhausted": "已达使用上限"
  },
  "decisionReasonLabels": {
    "decisionReason.safety_hold": "安全复核",
    "decisionReason.privacy_request": "隐私请求",
    "decisionReason.rights_concern": "权利或授权问题",
    "decisionReason.quality_or_duplicate": "重复或无法正常展示",
    "decisionReason.abusive_or_illegal": "有害或违法内容",
    "decisionReason.rights_violation": "权利侵害",
    "decisionReason.unrelated_content": "与空间无关",
    "decisionReason.repeated_violation": "重复违规",
    "decisionReason.appeal_upheld": "申诉复核通过",
    "decisionReason.review_corrected": "审核纠正",
    "decisionReason.issue_resolved": "问题已解决",
    "decisionReason.new_evidence": "有新信息",
    "decisionReason.uploader_appeal": "上传者申诉",
    "decisionReason.reviewer_correction": "审核者重新处理",
    "decisionReason.other": "其他"
  },
  "validationMessages": {
    "decisionReason.other_note_required": "选择“其他”时，请填写说明。"
  },
  "contextLabels": {
    "contextLabels.UPLOAD.OPEN.p08_new_batch": "重新选择照片（新建一批）"
  },
  "callerStrings": {
    "INVITATION.COPY_LINK": {
      "activity": {
        "initial": "复制活动链接",
        "loading": "正在复制活动链接…",
        "success": "活动链接已复制",
        "stable_error": "暂时无法复制活动链接，请重试。",
        "retry": "重新复制活动链接",
        "session_or_permission_loss": "你现在不能读取这条活动邀请。",
        "empty": "没有可复制的活动链接。",
        "destructive_confirm": null,
        "return": "返回活动邀请"
      },
      "member": {
        "initial": "复制成员邀请链接",
        "loading": "正在复制成员邀请链接…",
        "success": "成员邀请链接已复制",
        "stable_error": "暂时无法复制成员邀请链接，请重试。",
        "retry": "重新复制成员邀请链接",
        "session_or_permission_loss": "这条成员邀请链接已不再显示，请创建新邀请。",
        "empty": "没有可复制的成员邀请链接。",
        "destructive_confirm": null,
        "return": "返回成员管理"
      }
    }
  },
  "actions": {
    "HOME.OPEN_SPACE": {
      "initial": "打开空间",
      "loading": "正在打开空间…",
      "success": "空间已打开",
      "stable_error": "没有找到可打开的空间，请检查链接或重新扫码。",
      "retry": "重新打开",
      "session_or_permission_loss": "当前访问已失效，请重新打开邀请。",
      "empty": "输入邀请链接或扫描二维码。",
      "destructive_confirm": null,
      "return": "返回首页"
    },
    "AUTH.OPEN_LOGIN": {
      "initial": "登录",
      "loading": "正在打开登录…",
      "success": null,
      "stable_error": "登录页暂时无法打开。",
      "retry": "重新打开登录",
      "session_or_permission_loss": null,
      "empty": null,
      "destructive_confirm": null,
      "return": "返回首页"
    },
    "AUTH.REQUEST_CODE": {
      "initial": "获取验证码",
      "loading": "正在发送验证码…",
      "success": "验证码已发送，请查看邮箱。",
      "stable_error": "验证码暂时无法发送，请稍后重试。",
      "retry": "重新发送",
      "session_or_permission_loss": "本次登录已失效，请重新获取验证码。",
      "empty": "输入已验证邮箱。",
      "destructive_confirm": null,
      "return": "返回"
    },
    "AUTH.VERIFY_CODE": {
      "initial": "登录",
      "loading": "正在验证…",
      "success": "登录成功",
      "stable_error": "验证码不正确或已过期，请重新获取。",
      "retry": "重新验证",
      "session_or_permission_loss": "本次登录已失效，请重新获取验证码。",
      "empty": "输入邮箱中的验证码。",
      "destructive_confirm": null,
      "return": "返回"
    },
    "AUTH.LOGOUT": {
      "initial": "退出登录",
      "loading": "正在退出…",
      "success": "已退出登录",
      "stable_error": "暂时无法退出，请重试。",
      "retry": "重试退出",
      "session_or_permission_loss": null,
      "empty": null,
      "destructive_confirm": "退出后，这台设备需要重新登录才能进入我的空间。",
      "return": "返回账号"
    },
    "AUTH.LOGOUT_ALL": {
      "initial": "退出所有设备",
      "loading": "正在退出所有设备…",
      "success": "已退出所有设备",
      "stable_error": "暂时无法退出所有设备，请重试。",
      "retry": "重新退出所有设备",
      "session_or_permission_loss": "请重新登录并验证身份。",
      "empty": null,
      "destructive_confirm": "所有设备上的登录都会失效，需要重新登录。",
      "return": "返回账号"
    },
    "AUTH.REAUTH_REQUEST_CODE": {
      "initial": "获取验证码",
      "loading": "正在发送验证码…",
      "success": "验证码已发送，请查看邮箱。",
      "stable_error": "验证码暂时无法发送，请稍后重试。",
      "retry": "重新发送",
      "session_or_permission_loss": "登录已过期，请重新登录。",
      "empty": "向当前验证邮箱发送验证码。",
      "destructive_confirm": null,
      "return": "返回上一页"
    },
    "AUTH.REAUTHENTICATE": {
      "initial": "验证身份",
      "loading": "正在验证身份…",
      "success": "身份已验证",
      "stable_error": "无法完成身份验证，请重试。",
      "retry": "重新验证",
      "session_or_permission_loss": "验证已过期，请重新开始。",
      "empty": "完成验证后再继续。",
      "destructive_confirm": null,
      "return": "返回上一页"
    },
    "MY_SPACES.OPEN": {
      "initial": "我的空间",
      "loading": "正在加载我的空间…",
      "success": null,
      "stable_error": "暂时无法加载我的空间。",
      "retry": "重新加载",
      "session_or_permission_loss": "登录已过期，请重新登录。",
      "empty": "还没有空间。创建一个空间开始收集照片。",
      "destructive_confirm": null,
      "return": "返回首页"
    },
    "MY_SPACES.OPEN_ARCHIVED": {
      "initial": "已归档空间",
      "loading": "正在加载已归档空间…",
      "success": null,
      "stable_error": "暂时无法加载已归档空间。",
      "retry": "重新加载",
      "session_or_permission_loss": "登录已过期，请重新登录。",
      "empty": "没有已归档空间。",
      "destructive_confirm": null,
      "return": "返回我的空间"
    },
    "SPACE.OPEN_CREATE": {
      "initial": "创建空间",
      "loading": "正在打开创建空间…",
      "success": null,
      "stable_error": "创建空间页面暂时无法打开。",
      "retry": "重新打开创建空间",
      "session_or_permission_loss": "登录已过期，请重新登录。",
      "empty": null,
      "destructive_confirm": null,
      "return": "返回我的空间"
    },
    "SPACE.CREATE": {
      "initial": "创建空间",
      "loading": "正在创建空间…",
      "success": "空间已创建",
      "stable_error": "空间暂时无法创建，请重试。",
      "retry": "重新创建",
      "session_or_permission_loss": "登录已过期，请重新登录。",
      "empty": "填写空间名称。",
      "destructive_confirm": null,
      "return": "返回我的空间"
    },
    "SPACE.OPEN": {
      "initial": "打开空间",
      "loading": "正在加载空间…",
      "success": null,
      "stable_error": "空间暂时无法打开。",
      "retry": "重新加载",
      "session_or_permission_loss": "当前访问已失效，请重新打开邀请或登录。",
      "empty": "这个空间还没有照片。",
      "destructive_confirm": null,
      "return": "返回我的空间"
    },
    "INVITATION.EXCHANGE": {
      "initial": "继续",
      "loading": "正在验证邀请…",
      "success": "邀请已验证",
      "stable_error": "这个邀请现在无法使用，请稍后重试或向邀请人确认。",
      "retry": "重新验证邀请",
      "session_or_permission_loss": "这个邀请无法使用，请向邀请人获取新链接。",
      "empty": "打开邀请链接或扫描二维码。",
      "destructive_confirm": null,
      "return": "返回首页"
    },
    "INVITATION.SCAN_AGAIN": {
      "initial": "扫描二维码",
      "loading": "正在打开相机…",
      "success": "已识别邀请",
      "stable_error": "无法识别二维码，请重试或粘贴邀请链接。",
      "retry": "重新扫码",
      "session_or_permission_loss": null,
      "empty": "将二维码放入取景框。",
      "destructive_confirm": null,
      "return": "返回首页"
    },
    "INVITATION.COPY_LINK": {
      "initial": null,
      "loading": null,
      "success": null,
      "stable_error": null,
      "retry": null,
      "session_or_permission_loss": null,
      "empty": null,
      "destructive_confirm": null,
      "return": null
    },
    "INVITATION.SHOW_QR": {
      "initial": "显示二维码",
      "loading": "正在生成二维码…",
      "success": "二维码已显示",
      "stable_error": "无法生成二维码，请复制链接。",
      "retry": "重新生成二维码",
      "session_or_permission_loss": "你现在不能显示这个二维码。请返回邀请管理或重新登录。",
      "empty": "没有可显示的活动链接。",
      "destructive_confirm": null,
      "return": "关闭二维码"
    },
    "VIEW.OPEN_ALBUM": {
      "initial": "相册",
      "loading": "正在加载照片…",
      "success": null,
      "stable_error": "照片暂时无法加载。",
      "retry": "重新加载",
      "session_or_permission_loss": "当前访问已失效，请重新打开邀请。",
      "empty": "这个空间还没有可查看的照片。",
      "destructive_confirm": null,
      "return": "返回空间"
    },
    "VIEW.OPEN_SCENE": {
      "initial": "现场",
      "loading": "正在加载现场…",
      "success": null,
      "stable_error": "现场暂时无法加载，你仍可查看相册。",
      "retry": "重新加载现场",
      "session_or_permission_loss": "当前访问已失效，请重新打开邀请。",
      "empty": "这个空间暂时没有现场。",
      "destructive_confirm": null,
      "return": "返回相册"
    },
    "PHOTO.OPEN_DETAIL": {
      "initial": "查看照片",
      "loading": "正在加载照片…",
      "success": null,
      "stable_error": "照片暂时无法加载。",
      "retry": "重新加载",
      "session_or_permission_loss": "当前访问已失效，请重新打开邀请。",
      "empty": "这张照片已不可查看。",
      "destructive_confirm": null,
      "return": "返回原来的相册位置"
    },
    "PHOTO.RETURN_TO_SCENE": {
      "initial": "回到现场",
      "loading": "正在回到照片所在位置…",
      "success": "已回到照片所在位置",
      "stable_error": "现场暂时无法打开，你仍可查看照片。",
      "retry": "重试打开现场",
      "session_or_permission_loss": "当前访问已失效，请重新打开邀请。",
      "empty": null,
      "destructive_confirm": null,
      "return": "返回照片"
    },
    "UPLOAD.ACCEPT_NOTICE": {
      "initial": "同意并继续",
      "loading": "正在记录同意…",
      "success": "可以选择照片了",
      "stable_error": "暂时无法记录同意，请重试。",
      "retry": "重新提交",
      "session_or_permission_loss": "上传访问已失效，请重新打开邀请。",
      "empty": "请先阅读照片处理与可见范围说明。",
      "destructive_confirm": null,
      "return": "返回邀请"
    },
    "UPLOAD.OPEN": {
      "initial": "上传照片",
      "loading": "正在打开上传…",
      "success": null,
      "stable_error": "上传页面暂时无法打开。",
      "retry": "重新打开上传",
      "session_or_permission_loss": "上传权限已失效，请返回后重新进入上传。",
      "empty": "当前不能上传照片。",
      "destructive_confirm": null,
      "return": "返回原页面"
    },
    "UPLOAD.SELECT_FILES": {
      "initial": "选择照片",
      "loading": "正在建立本次上传并读取照片…",
      "success": "本次上传已建立，照片已加入",
      "stable_error": "暂时无法建立本次上传，请重试。",
      "retry": "重新选择",
      "session_or_permission_loss": "当前上传流程已失效，请返回后重新进入上传。",
      "empty": "选择一张或多张照片。",
      "destructive_confirm": null,
      "return": "返回空间"
    },
    "UPLOAD.REMOVE_ITEM": {
      "initial": "移出本次上传",
      "loading": "正在移除…",
      "success": "已移出本次上传",
      "stable_error": "暂时无法移除，请重试。",
      "retry": "重新移除",
      "session_or_permission_loss": "上传访问已失效，请重新打开邀请。",
      "empty": null,
      "destructive_confirm": "只会从本次选择中移除，不会删除手机里的照片。",
      "return": "返回本次上传"
    },
    "UPLOAD.RETRY_ITEM": {
      "initial": "重试这张",
      "loading": "正在重新上传这张照片…",
      "success": "这张照片已上传",
      "stable_error": "这张照片仍未上传，请检查网络或文件。",
      "retry": "再次重试",
      "session_or_permission_loss": "上传访问已失效，请重新打开邀请。",
      "empty": null,
      "destructive_confirm": null,
      "return": "返回本次上传"
    },
    "UPLOAD.FINALIZE_BATCH": {
      "initial": "完成本次上传",
      "loading": "正在完成本次上传…",
      "success": "本次上传结果已确定",
      "stable_error": "暂时无法完成本次上传，请重试同一次操作。",
      "retry": "重新完成本次上传",
      "session_or_permission_loss": "上传访问已失效；请重新打开邀请查看是否已完成。",
      "empty": "本次上传还没有可完成的照片。",
      "destructive_confirm": "完成后，本批结果将固定；未成功的照片需要在新的上传中重传。",
      "return": "返回空间"
    },
    "BATCH.OPEN_RESULT": {
      "initial": "查看本次上传",
      "loading": "正在恢复本次上传…",
      "success": null,
      "stable_error": "暂时无法加载本次上传。",
      "retry": "重新加载",
      "session_or_permission_loss": "这台设备无法恢复本次上传；请使用已绑定的账号登录。",
      "empty": "本次上传没有成功保存的照片。",
      "destructive_confirm": null,
      "return": "返回空间"
    },
    "BATCH.OPEN_ITEM": {
      "initial": "打开照片结果",
      "loading": "正在加载照片结果…",
      "success": null,
      "stable_error": "照片结果暂时无法加载。",
      "retry": "重新加载照片结果",
      "session_or_permission_loss": "当前访问已失效；请重新恢复本次上传。",
      "empty": "这张照片没有可查看的结果。",
      "destructive_confirm": null,
      "return": "返回本次上传"
    },
    "BATCH_RECEIPT.EXCHANGE": {
      "initial": "打开本次上传结果",
      "loading": "正在恢复本次上传结果…",
      "success": "本次上传结果已恢复",
      "stable_error": "这个上传结果无法恢复，请使用已绑定的账号或联系支持。",
      "retry": "重新恢复",
      "session_or_permission_loss": "这个上传结果无法恢复，请使用已绑定的账号或联系支持。",
      "empty": "打开本次上传结果链接。",
      "destructive_confirm": null,
      "return": "返回首页"
    },
    "BATCH_BINDING.REQUEST_CODE": {
      "initial": "发送绑定验证码",
      "loading": "正在发送验证码…",
      "success": "验证码已发送，请查看邮箱。",
      "stable_error": "验证码暂时无法发送，请重试。",
      "retry": "重新发送",
      "session_or_permission_loss": "本次上传访问已失效，请重新恢复。",
      "empty": "输入要绑定的验证邮箱。",
      "destructive_confirm": null,
      "return": "返回本次上传"
    },
    "BATCH_BINDING.CONFIRM": {
      "initial": "绑定恢复邮箱",
      "loading": "正在验证并绑定…",
      "success": "恢复邮箱已绑定",
      "stable_error": "验证码不正确或已过期，请重新获取。",
      "retry": "重新验证",
      "session_or_permission_loss": "本次上传访问已失效，请重新恢复。",
      "empty": "输入邮箱中的验证码。",
      "destructive_confirm": null,
      "return": "返回本次上传"
    },
    "BATCH.OPEN_ACCOUNT_UPLOADS": {
      "initial": "我的上传",
      "loading": "正在加载我的上传…",
      "success": null,
      "stable_error": "我的上传暂时无法加载。",
      "retry": "重新加载我的上传",
      "session_or_permission_loss": "登录已过期，请重新登录。",
      "empty": "这个账号没有可恢复的上传。",
      "destructive_confirm": null,
      "return": "返回账号"
    },
    "BATCH.RECOVER_FROM_ACCOUNT": {
      "initial": "恢复我的上传",
      "loading": "正在恢复上传记录…",
      "success": "上传记录已恢复",
      "stable_error": "暂时无法恢复上传记录。",
      "retry": "重新恢复",
      "session_or_permission_loss": "请用上传时绑定的邮箱登录。",
      "empty": "这个账号没有可恢复的上传。",
      "destructive_confirm": null,
      "return": "返回账号"
    },
    "BATCH_RECEIPT.REVOKE": {
      "initial": "停止访问本次上传",
      "loading": "正在停止访问…",
      "success": "本次上传的访问已停止",
      "stable_error": "暂时无法停止访问，请重试。",
      "retry": "重新停止访问",
      "session_or_permission_loss": "当前访问已失效。",
      "empty": null,
      "destructive_confirm": "这会退出本批结果的所有设备；已绑定账号也不能再恢复。",
      "return": "返回我的上传"
    },
    "BATCH.DELETE_ITEM": {
      "initial": "删除这张照片",
      "loading": "正在删除照片…",
      "success": "照片已删除",
      "stable_error": "照片暂时无法删除，请重试。",
      "retry": "重新删除",
      "session_or_permission_loss": "你现在不能删除这张照片。",
      "empty": null,
      "destructive_confirm": "这张照片会从空间和本次上传中移除，相关位置与处理结果也会删除。",
      "return": "返回本次上传"
    },
    "PLACEMENT.RETRY": {
      "initial": "重新定位",
      "loading": "正在重新定位…",
      "success": "定位已更新",
      "stable_error": "仍然无法自动定位，请手动调整。",
      "retry": "再次定位",
      "session_or_permission_loss": "你现在不能调整这张照片的位置。",
      "empty": null,
      "destructive_confirm": null,
      "return": "返回照片结果"
    },
    "PLACEMENT.CONFIRM": {
      "initial": "确认位置",
      "loading": "正在保存位置…",
      "success": "位置已确认",
      "stable_error": "位置暂时无法保存，请重试。",
      "retry": "重新保存",
      "session_or_permission_loss": "你现在不能调整这张照片的位置。",
      "empty": "先选择照片所在方向。",
      "destructive_confirm": null,
      "return": "返回照片结果"
    },
    "PLACEMENT.OPEN_EDITOR": {
      "initial": "调整位置",
      "loading": "正在打开位置编辑…",
      "success": null,
      "stable_error": "位置编辑暂时无法打开。",
      "retry": "重新打开",
      "session_or_permission_loss": "你现在不能调整这张照片的位置。",
      "empty": "当前没有可编辑的位置。",
      "destructive_confirm": null,
      "return": "返回照片"
    },
    "PLACEMENT.SAVE": {
      "initial": "保存位置",
      "loading": "正在保存位置…",
      "success": "位置已保存",
      "stable_error": "位置暂时无法保存，请重试。",
      "retry": "重新保存",
      "session_or_permission_loss": "你的编辑权限已变化，请返回后刷新。",
      "empty": "先选择照片所在方向。",
      "destructive_confirm": null,
      "return": "返回照片"
    },
    "PLACEMENT.UNDO": {
      "initial": "撤回这次修改",
      "loading": "正在撤回修改…",
      "success": "已恢复到上一个位置",
      "stable_error": "暂时无法撤回，请重试。",
      "retry": "重新撤回",
      "session_or_permission_loss": "你现在不能撤回这次修改。",
      "empty": "没有可撤回的位置修改。",
      "destructive_confirm": "将创建一条新的恢复记录，不会删除历史。",
      "return": "返回照片"
    },
    "PLACEMENT.MARK_OUTSIDE": {
      "initial": "不属于这个现场",
      "loading": "正在更新位置状态…",
      "success": "已标记为不属于这个现场",
      "stable_error": "暂时无法更新，请重试。",
      "retry": "重新提交",
      "session_or_permission_loss": "你现在不能更改这张照片的位置。",
      "empty": null,
      "destructive_confirm": "这张照片将不再显示“回到现场”，之后仍可重新定位。",
      "return": "返回照片"
    },
    "PLACEMENT.REOPEN_FOR_CONTRIBUTOR": {
      "initial": "允许上传者再次调整",
      "loading": "正在恢复调整权限…",
      "success": "上传者可以再次调整这张照片",
      "stable_error": "暂时无法恢复调整权限。",
      "retry": "重新恢复",
      "session_or_permission_loss": "只有空间主人可以执行此操作。",
      "empty": null,
      "destructive_confirm": "上传者将可以再次修改这一张照片的位置。",
      "return": "返回位置详情"
    },
    "NOTE.OPT_IN": {
      "initial": "生成现场注脚",
      "loading": "正在准备注脚…",
      "success": "注脚生成已开始",
      "stable_error": "注脚暂时无法生成，不影响照片和位置。",
      "retry": "重新生成",
      "session_or_permission_loss": "本次注脚体验已结束。",
      "empty": "可选：基于照片可见事实生成草稿。",
      "destructive_confirm": null,
      "return": "返回照片结果"
    },
    "NOTE.CONFIRM": {
      "initial": "保存为我的注脚",
      "loading": "正在保存注脚…",
      "success": "注脚已保存给你自己查看",
      "stable_error": "注脚暂时无法保存，不影响照片和位置。",
      "retry": "重新保存",
      "session_or_permission_loss": "本次注脚体验已结束。",
      "empty": "还没有可保存的注脚。",
      "destructive_confirm": null,
      "return": "返回照片结果"
    },
    "NOTE.WITHDRAW": {
      "initial": "撤回我的注脚",
      "loading": "正在撤回注脚…",
      "success": "注脚已撤回",
      "stable_error": "注脚暂时无法撤回，请重试。",
      "retry": "重新撤回",
      "session_or_permission_loss": "本次注脚体验已结束。",
      "empty": "没有可撤回的注脚。",
      "destructive_confirm": "撤回后将不再为你显示这条注脚。",
      "return": "返回照片结果"
    },
    "MANAGE.OPEN": {
      "initial": "管理",
      "loading": "正在加载待办…",
      "success": null,
      "stable_error": "管理内容暂时无法加载。",
      "retry": "重新加载",
      "session_or_permission_loss": "你的管理权限已变化，请返回我的空间。",
      "empty": "现在没有待处理事项。",
      "destructive_confirm": null,
      "return": "返回我的空间"
    },
    "MANAGE.OPEN_NEXT": {
      "initial": "处理下一项",
      "loading": "正在打开下一项…",
      "success": null,
      "stable_error": "这项刚刚已被处理，请重新打开下一项。",
      "retry": "重新打开下一项",
      "session_or_permission_loss": "你的管理权限已变化，请返回我的空间。",
      "empty": "现在没有可处理的事项。",
      "destructive_confirm": null,
      "return": "返回管理"
    },
    "CONTENT.APPROVE": {
      "initial": "通过",
      "loading": "正在通过照片…",
      "success": "照片已通过审核",
      "stable_error": "暂时无法通过，请重试。",
      "retry": "重新通过",
      "session_or_permission_loss": "你现在不能审核这张照片。",
      "empty": null,
      "destructive_confirm": null,
      "return": "返回审核队列"
    },
    "CONTENT.HIDE": {
      "initial": "隐藏",
      "loading": "正在隐藏照片…",
      "success": "照片已隐藏",
      "stable_error": "暂时无法隐藏，请重试。",
      "retry": "重新隐藏",
      "session_or_permission_loss": "你现在不能审核这张照片。",
      "empty": "请选择审核原因。",
      "destructive_confirm": "受邀观看者将无法再看到这张照片。",
      "return": "返回审核队列"
    },
    "CONTENT.REJECT": {
      "initial": "拒绝",
      "loading": "正在拒绝照片…",
      "success": "照片已拒绝",
      "stable_error": "暂时无法拒绝，请重试。",
      "retry": "重新拒绝",
      "session_or_permission_loss": "你现在不能审核这张照片。",
      "empty": "请选择审核原因。",
      "destructive_confirm": "照片不会向受邀观看者显示；上传者可查看处理结果并申诉。",
      "return": "返回审核队列"
    },
    "CONTENT.RESTORE": {
      "initial": "恢复显示",
      "loading": "正在恢复照片…",
      "success": "照片已恢复显示",
      "stable_error": "暂时无法恢复，请重试。",
      "retry": "重新恢复",
      "session_or_permission_loss": "你现在不能审核这张照片。",
      "empty": "请选择恢复原因。",
      "destructive_confirm": null,
      "return": "返回审核队列"
    },
    "CONTENT.REOPEN": {
      "initial": "重新审核",
      "loading": "正在重新打开审核…",
      "success": "照片已回到待审核",
      "stable_error": "暂时无法重新打开审核。",
      "retry": "重新提交",
      "session_or_permission_loss": "你现在不能审核这张照片。",
      "empty": "请选择重新审核原因。",
      "destructive_confirm": null,
      "return": "返回审核队列"
    },
    "PANORAMA.UPLOAD_CANDIDATE": {
      "initial": "上传新的现场",
      "loading": "正在上传并检查新的现场…",
      "success": "新的现场已准备好，可以使用",
      "stable_error": "新的现场未能准备好；当前现场没有变化。",
      "retry": "重新上传新的现场",
      "session_or_permission_loss": "你现在不能管理现场。",
      "empty": "选择一张已生成的 2:1 全景照片。",
      "destructive_confirm": null,
      "return": "返回现场管理"
    },
    "PANORAMA.SWITCH_CANDIDATE": {
      "initial": "使用这个现场",
      "loading": "正在使用这个现场…",
      "success": "已使用新的现场；旧照片位置需要重新确认",
      "stable_error": "暂时无法使用这个现场；当前现场没有变化。",
      "retry": "重新使用这个现场",
      "session_or_permission_loss": "你现在不能管理现场。",
      "empty": "没有已准备好的新现场。",
      "destructive_confirm": "使用后，旧照片位置会标为需要更新。",
      "return": "返回现场管理"
    },
    "PANORAMA.ROLLBACK": {
      "initial": "恢复上一版现场",
      "loading": "正在恢复上一版现场…",
      "success": "已恢复上一版现场；照片位置不会自动恢复",
      "stable_error": "暂时无法恢复上一版现场；当前现场没有变化。",
      "retry": "重新恢复上一版现场",
      "session_or_permission_loss": "你现在不能管理现场。",
      "empty": "没有可恢复的上一版现场。",
      "destructive_confirm": "恢复上一版现场不会覆盖任何位置历史。",
      "return": "返回现场管理"
    },
    "EXTERNAL_INVITATION.CREATE": {
      "initial": "创建活动邀请",
      "loading": "正在创建活动邀请…",
      "success": "活动邀请已创建",
      "stable_error": "活动邀请暂时无法创建，请重试。",
      "retry": "重新创建",
      "session_or_permission_loss": "你现在不能创建活动邀请。",
      "empty": "选择“查看照片”“上传照片”或两者都选。",
      "destructive_confirm": null,
      "return": "返回活动邀请"
    },
    "EXTERNAL_INVITATION.REVOKE": {
      "initial": "撤销活动邀请",
      "loading": "正在撤销活动邀请…",
      "success": "活动邀请已撤销",
      "stable_error": "活动邀请暂时无法撤销，请重试。",
      "retry": "重新撤销",
      "session_or_permission_loss": "你现在不能撤销活动邀请。",
      "empty": null,
      "destructive_confirm": "撤销后，所有人将不能再通过这条活动邀请进入。",
      "return": "返回活动邀请"
    },
    "MEMBER_INVITATION.CREATE": {
      "initial": "创建成员邀请",
      "loading": "正在创建成员邀请…",
      "success": "成员邀请已创建",
      "stable_error": "成员邀请暂时无法创建。",
      "retry": "重新创建",
      "session_or_permission_loss": "只有空间主人可以创建成员邀请。",
      "empty": "输入对方已验证的邮箱。",
      "destructive_confirm": null,
      "return": "返回成员管理"
    },
    "MEMBER_INVITATION.ACCEPT": {
      "initial": "接受邀请",
      "loading": "正在验证邀请并加入空间…",
      "success": "已加入空间，可从我的空间进入",
      "stable_error": "这个成员邀请无法使用。请重新登录，或向邀请人获取新链接。",
      "retry": "重新登录",
      "session_or_permission_loss": "这个成员邀请无法使用。请重新登录，或向邀请人获取新链接。",
      "empty": "登录后接受成员邀请。",
      "destructive_confirm": null,
      "return": "返回我的空间"
    },
    "MEMBER_INVITATION.REVOKE": {
      "initial": "撤销成员邀请",
      "loading": "正在撤销邀请…",
      "success": "成员邀请已撤销",
      "stable_error": "成员邀请暂时无法撤销。",
      "retry": "重新撤销",
      "session_or_permission_loss": "只有空间主人可以撤销成员邀请。",
      "empty": null,
      "destructive_confirm": "对方将不能再接受这条成员邀请。",
      "return": "返回成员管理"
    },
    "MEMBERSHIP.UPDATE": {
      "initial": "保存成员权限",
      "loading": "正在保存成员权限…",
      "success": "成员权限已更新",
      "stable_error": "成员权限暂时无法保存。",
      "retry": "重新保存",
      "session_or_permission_loss": "只有空间主人可以修改成员权限。",
      "empty": "至少选择一项任务或管理权限。",
      "destructive_confirm": null,
      "return": "返回成员管理"
    },
    "MEMBERSHIP.REVOKE": {
      "initial": "移除成员",
      "loading": "正在移除成员…",
      "success": "成员已移除",
      "stable_error": "成员暂时无法移除。",
      "retry": "重新移除",
      "session_or_permission_loss": "只有空间主人可以移除成员。",
      "empty": null,
      "destructive_confirm": "此成员将失去这个空间的访问和管理权限。",
      "return": "返回成员管理"
    },
    "COLLECTION.PAUSE": {
      "initial": "暂停收集",
      "loading": "正在暂停收集…",
      "success": "已暂停收集照片",
      "stable_error": "暂时无法暂停收集。",
      "retry": "重新暂停",
      "session_or_permission_loss": "只有空间主人可以更改收集状态。",
      "empty": null,
      "destructive_confirm": "新的上传邀请暂时不能使用，已保存照片不受影响。",
      "return": "返回空间设置"
    },
    "COLLECTION.RESUME": {
      "initial": "继续收集",
      "loading": "正在恢复收集…",
      "success": "已继续收集照片",
      "stable_error": "暂时无法恢复收集。",
      "retry": "重新恢复",
      "session_or_permission_loss": "只有空间主人可以更改收集状态。",
      "empty": null,
      "destructive_confirm": null,
      "return": "返回空间设置"
    },
    "SHARING.ENABLE": {
      "initial": "开启受邀查看",
      "loading": "正在开启受邀查看…",
      "success": "受邀查看已开启",
      "stable_error": "暂时无法开启受邀查看。",
      "retry": "重新开启",
      "session_or_permission_loss": "你现在不能更改分享状态。",
      "empty": null,
      "destructive_confirm": null,
      "return": "返回空间设置"
    },
    "SHARING.DISABLE": {
      "initial": "停止受邀查看",
      "loading": "正在停止受邀查看…",
      "success": "受邀查看已停止",
      "stable_error": "暂时无法停止受邀查看。",
      "retry": "重新停止",
      "session_or_permission_loss": "你现在不能更改分享状态。",
      "empty": null,
      "destructive_confirm": "已有查看邀请将无法继续打开空间。",
      "return": "返回空间设置"
    },
    "SPACE.ARCHIVE": {
      "initial": "归档空间",
      "loading": "正在归档空间…",
      "success": "空间已归档",
      "stable_error": "空间暂时无法归档。",
      "retry": "重新归档",
      "session_or_permission_loss": "请重新验证身份；空间尚未归档。",
      "empty": null,
      "destructive_confirm": "归档后，受邀观看、上传和管理入口都会关闭；主人仍可导出、恢复或申请删除。",
      "return": "返回我的空间"
    },
    "SPACE.RESTORE": {
      "initial": "恢复空间",
      "loading": "正在恢复空间…",
      "success": "空间已恢复；分享与收集仍按恢复后的安全状态设置",
      "stable_error": "空间暂时无法恢复。",
      "retry": "重新恢复",
      "session_or_permission_loss": "请重新验证身份；空间尚未恢复。",
      "empty": null,
      "destructive_confirm": null,
      "return": "返回我的空间"
    },
    "SPACE.EXPORT": {
      "initial": "导出空间",
      "loading": "正在准备导出…",
      "success": "导出文件已准备好",
      "stable_error": "暂时无法准备导出，请重试。",
      "retry": "重新导出",
      "session_or_permission_loss": "只有空间主人可以导出空间。",
      "empty": "这个空间没有可导出的内容。",
      "destructive_confirm": null,
      "return": "返回空间"
    },
    "SPACE.DELETE_REQUEST": {
      "initial": "申请删除空间",
      "loading": "正在提交删除申请…",
      "success": "删除申请已提交；访问已关闭",
      "stable_error": "暂时无法提交删除申请。",
      "retry": "重新提交",
      "session_or_permission_loss": "请重新验证身份；删除申请尚未提交。",
      "empty": null,
      "destructive_confirm": "空间、照片、现场和相关处理结果将按删除流程清理。此操作需要再次验证身份。",
      "return": "返回我的空间"
    },
    "ACCOUNT.OPEN": {
      "initial": "账号设置",
      "loading": "正在加载账号设置…",
      "success": null,
      "stable_error": "账号设置暂时无法加载。",
      "retry": "重新加载",
      "session_or_permission_loss": "登录已过期，请重新登录。",
      "empty": null,
      "destructive_confirm": null,
      "return": "返回"
    },
    "ACCOUNT.EXPORT": {
      "initial": "导出我的数据",
      "loading": "正在准备导出…",
      "success": "导出任务已创建",
      "stable_error": "暂时无法创建导出任务。",
      "retry": "重新导出",
      "session_or_permission_loss": "登录已过期，请重新登录。",
      "empty": "没有可导出的账号数据。",
      "destructive_confirm": null,
      "return": "返回账号"
    },
    "ACCOUNT.DELETE_REQUEST": {
      "initial": "申请删除账号",
      "loading": "正在提交删除申请…",
      "success": "删除申请已提交",
      "stable_error": "暂时无法提交删除申请。",
      "retry": "重新提交",
      "session_or_permission_loss": "请重新验证身份；删除申请尚未提交。",
      "empty": null,
      "destructive_confirm": "账号将退出所有设备。若你拥有空间，需先转移或删除这些空间。",
      "return": "返回账号"
    },
    "OWNER_TRANSFER.CREATE": {
      "initial": "发起主人转移",
      "loading": "正在发起主人转移…",
      "success": "主人转移已创建，等待对方接受",
      "stable_error": "暂时无法发起转移，请重试。",
      "retry": "重新发起",
      "session_or_permission_loss": "请重新验证身份。",
      "empty": "请选择一个已验证的现有空间成员。",
      "destructive_confirm": "对方在账号内接受后，你将不再是这个空间的主人。",
      "return": "返回账号设置"
    },
    "OWNER_TRANSFER.ACCEPT": {
      "initial": "接受主人转移",
      "loading": "正在接受转移…",
      "success": "你已成为这个空间的主人",
      "stable_error": "暂时无法接受转移，请重试。",
      "retry": "重新接受",
      "session_or_permission_loss": "请使用指定账号登录并验证身份。",
      "empty": "没有可接受的主人转移。",
      "destructive_confirm": "接受后，你将承担这个空间的全部管理与处置责任。",
      "return": "返回我的空间"
    },
    "OWNER_TRANSFER.REVOKE": {
      "initial": "撤销主人转移",
      "loading": "正在撤销转移…",
      "success": "主人转移已撤销",
      "stable_error": "暂时无法撤销转移，请重试。",
      "retry": "重新撤销",
      "session_or_permission_loss": "你现在不能撤销这次转移。",
      "empty": null,
      "destructive_confirm": "对方将不能再接受这次主人转移。",
      "return": "返回账号设置"
    },
    "EXPORT.OPEN_STATUS": {
      "initial": "查看导出进度",
      "loading": "正在查询导出进度…",
      "success": null,
      "stable_error": "暂时无法查询导出进度。",
      "retry": "重新查询",
      "session_or_permission_loss": "你现在不能查看这份导出。",
      "empty": "没有进行中的导出。",
      "destructive_confirm": null,
      "return": "返回导出页"
    },
    "EXPORT.DOWNLOAD": {
      "initial": "下载导出文件",
      "loading": "正在准备下载…",
      "success": "下载已开始",
      "stable_error": "下载链接已失效或暂时不可用，请重新准备。",
      "retry": "重新准备下载",
      "session_or_permission_loss": "你现在不能下载这份导出。",
      "empty": "导出文件尚未准备好。",
      "destructive_confirm": null,
      "return": "返回导出进度"
    },
    "DELETION.OPEN_STATUS": {
      "initial": "查看删除进度",
      "loading": "正在查询删除进度…",
      "success": null,
      "stable_error": "暂时无法查询删除进度。",
      "retry": "重新查询",
      "session_or_permission_loss": "你现在不能查看这项删除申请。",
      "empty": "没有进行中的删除申请。",
      "destructive_confirm": null,
      "return": "返回账号或空间"
    },
    "REPORT.SUBMIT": {
      "initial": "提交举报",
      "loading": "正在提交举报…",
      "success": "举报已提交",
      "stable_error": "举报暂时无法提交，请重试。",
      "retry": "重新提交",
      "session_or_permission_loss": "当前访问无法关联这个内容；你仍可提交通用安全线索。",
      "empty": "选择问题类型并说明情况。",
      "destructive_confirm": null,
      "return": "返回原内容"
    },
    "REPORT.OPEN_STATUS": {
      "initial": "查询举报进度",
      "loading": "正在查询举报进度…",
      "success": null,
      "stable_error": "暂时无法查询举报进度。",
      "retry": "重新查询",
      "session_or_permission_loss": "当前访问无法查看这条举报记录。",
      "empty": "输入举报编号。",
      "destructive_confirm": null,
      "return": "返回支持"
    },
    "APPEAL.SUBMIT": {
      "initial": "提交申诉",
      "loading": "正在提交申诉…",
      "success": "申诉已提交",
      "stable_error": "申诉暂时无法提交，请重试。",
      "retry": "重新提交",
      "session_or_permission_loss": "当前访问无法提交这张照片的申诉。",
      "empty": "说明你希望复核的原因。",
      "destructive_confirm": null,
      "return": "返回处理结果"
    },
    "APPEAL.OPEN_STATUS": {
      "initial": "查询申诉进度",
      "loading": "正在查询申诉进度…",
      "success": null,
      "stable_error": "暂时无法查询申诉进度。",
      "retry": "重新查询",
      "session_or_permission_loss": "当前访问无法查看这条申诉记录。",
      "empty": "输入申诉编号。",
      "destructive_confirm": null,
      "return": "返回支持"
    },
    "SUPPORT.OPEN": {
      "initial": "帮助与支持",
      "loading": "正在加载帮助…",
      "success": null,
      "stable_error": "帮助内容暂时无法加载。",
      "retry": "重新加载",
      "session_or_permission_loss": null,
      "empty": "选择你需要的帮助。",
      "destructive_confirm": null,
      "return": "返回"
    },
    "SUPPORT.SUBMIT_SAFETY_LEAD": {
      "initial": "提交安全线索",
      "loading": "正在提交安全线索…",
      "success": "安全线索已提交",
      "stable_error": "安全线索暂时无法提交，请重试。",
      "retry": "重新提交",
      "session_or_permission_loss": null,
      "empty": "请描述问题；不要填写邀请链接或照片编号。",
      "destructive_confirm": null,
      "return": "返回支持"
    },
    "SUPPORT.OPEN_STATUS": {
      "initial": "查看支持进度",
      "loading": "正在查询支持进度…",
      "success": null,
      "stable_error": "暂时无法查询支持进度。",
      "retry": "重新查询",
      "session_or_permission_loss": "当前访问无法查看这条支持记录。",
      "empty": "输入支持编号。",
      "destructive_confirm": null,
      "return": "返回支持"
    },
    "MEDIA_NOTICE.OPEN": {
      "initial": "查看照片处理说明",
      "loading": "正在加载照片处理说明…",
      "success": null,
      "stable_error": "照片处理说明暂时无法加载。",
      "retry": "重新加载",
      "session_or_permission_loss": "上传访问已失效，请重新打开邀请。",
      "empty": null,
      "destructive_confirm": null,
      "return": "返回上传照片"
    },
    "LEGAL.OPEN_PRIVACY": {
      "initial": "隐私说明",
      "loading": "正在加载隐私说明…",
      "success": null,
      "stable_error": "隐私说明暂时无法加载。",
      "retry": "重新加载",
      "session_or_permission_loss": null,
      "empty": null,
      "destructive_confirm": null,
      "return": "返回"
    },
    "LEGAL.OPEN_TERMS": {
      "initial": "服务条款",
      "loading": "正在加载服务条款…",
      "success": null,
      "stable_error": "服务条款暂时无法加载。",
      "retry": "重新加载",
      "session_or_permission_loss": null,
      "empty": null,
      "destructive_confirm": null,
      "return": "返回"
    }
  }
};
export const tokens = {
  "schemaVersion": 1,
  "name": "UNSEEN 共光",
  "source": "2026-07-25 六张早期美术参考图；见 SOURCE-OF-TRUTH.md",
  "updatedAt": "2026-08-13T12:15:00+10:00",
  "color": {
    "canvas": "#FFF9F7",
    "surface": "#FFFFFF",
    "surfaceWarm": "#FFF4F0",
    "surfaceMuted": "#F7F1EF",
    "ink": "#321722",
    "inkMuted": "#725F66",
    "inkSubtle": "#9A868D",
    "border": "#E9DDDA",
    "borderStrong": "#A57E75",
    "pink": "#FF96B2",
    "pinkSoft": "#FFD6E1",
    "gold": "#FFD678",
    "goldSoft": "#FFF0BF",
    "burgundy": "#461528",
    "success": "#2F7D63",
    "warning": "#9A6517",
    "danger": "#A43E4A",
    "info": "#436A84",
    "focus": "#461528",
    "scrim": "rgba(31, 13, 20, 0.58)",
    "primaryGradient": "linear-gradient(100deg, #FF96B2 0%, #FFD678 100%)",
    "haloGradient": "radial-gradient(circle, rgba(255,150,178,.30) 0%, rgba(255,214,120,.22) 45%, rgba(255,249,247,0) 74%)"
  },
  "colorUsage": {
    "text": {
      "primary": "ink",
      "secondary": "inkMuted",
      "metadata": "inkMuted",
      "disabled": "inkMuted"
    },
    "nonTextOnly": {
      "inkSubtle": [
        "decorative-placeholder",
        "non-semantic-hairline"
      ]
    },
    "rule": "inkSubtle MUST NOT be used for text; metadata MUST use inkMuted"
  },
  "type": {
    "latinDisplay": "Inter, ui-sans-serif, system-ui, sans-serif",
    "sans": "Inter, PingFang SC, Noto Sans CJK SC, Microsoft YaHei, ui-sans-serif, system-ui, sans-serif",
    "mono": "ui-monospace, SFMono-Regular, Menlo, monospace",
    "weight": {
      "regular": 400,
      "medium": 500,
      "semibold": 600
    },
    "size": {
      "xs": 12,
      "sm": 14,
      "body": 16,
      "bodyLarge": 18,
      "title3": 20,
      "title2": 24,
      "title1": 32,
      "display": 44
    },
    "lineHeight": {
      "xs": 16,
      "sm": 20,
      "body": 24,
      "bodyLarge": 28,
      "title3": 28,
      "title2": 32,
      "title1": 40,
      "display": 52
    },
    "tracking": {
      "brand": 0.22,
      "label": 0.01,
      "body": 0
    }
  },
  "spacing": {
    "0": 0,
    "1": 4,
    "2": 8,
    "3": 12,
    "4": 16,
    "5": 20,
    "6": 24,
    "8": 32,
    "10": 40,
    "12": 48,
    "16": 64,
    "20": 80
  },
  "breakpoint": {
    "mobileMax": 1247,
    "desktopMin": 1248
  },
  "layout": {
    "mobile": {
      "minViewport": 320,
      "maxViewport": 1247,
      "gutter": 16,
      "gridColumns": 4,
      "gridGap": 12,
      "contentMax": "100%",
      "bottomBarHeight": 64,
      "safeAreaPolicy": "env(safe-area-inset-*)"
    },
    "desktop": {
      "minViewport": 1248,
      "referenceViewport": 1280,
      "outerMaxViewport": 1440,
      "gutter": 32,
      "gridColumns": 12,
      "gridGap": 24,
      "contentWidth": 1184,
      "sidebarWidth": 224,
      "mainWidth": 936,
      "headerHeight": 64
    },
    "desktopFitEquation": "desktopMin = contentWidth + 2*gutter = 1184 + 64 = 1248; horizontal overflow is forbidden",
    "desktopGrowthRule": "1248 到 1440 只增加左右外留白；contentWidth、sidebarWidth、mainWidth、gridGap 与文本 measure 固定",
    "textMeasure": {
      "bodyMaxCh": 68,
      "formMax": 560,
      "dialogMax": 520,
      "managementThreeColumn": "240px minmax(328px, 1fr) 320px"
    }
  },
  "radius": {
    "xs": 6,
    "sm": 10,
    "md": 14,
    "lg": 20,
    "xl": 28,
    "pill": 999
  },
  "shadow": {
    "card": "0 8px 28px rgba(70, 21, 40, 0.08)",
    "raised": "0 16px 48px rgba(70, 21, 40, 0.14)",
    "focus": "0 0 0 3px rgba(70, 21, 40, 0.28)",
    "none": "none"
  },
  "border": {
    "hairline": 1,
    "emphasis": 2,
    "style": "solid"
  },
  "zIndex": {
    "base": 0,
    "sticky": 20,
    "dropdown": 40,
    "scrim": 60,
    "dialog": 70,
    "toast": 80,
    "focus": 90
  },
  "control": {
    "heightSm": 36,
    "heightMd": 44,
    "heightLg": 52,
    "icon": 20,
    "iconTouchTarget": 44,
    "fieldPaddingX": 14,
    "buttonPaddingX": 20
  },
  "mediaRatio": {
    "thumbnail": "4 / 3",
    "photoDetail": "intrinsic",
    "panorama": "2 / 1",
    "avatar": "1 / 1",
    "brandMark": "1 / 1"
  },
  "mediaFit": {
    "photoDetail": {
      "objectFit": "contain",
      "maxContainer": {
        "width": "100%",
        "height": "calc(100dvh - 128px)"
      }
    }
  },
  "darkViewer": {
    "canvas": "#170E12",
    "surface": "#24171D",
    "surfaceRaised": "#302027",
    "ink": "#FFF8F5",
    "inkMuted": "#CFBEC4",
    "border": "#8C6877",
    "control": "rgba(255,248,245,.35)",
    "controlHover": "rgba(255,248,245,.43)",
    "focus": "#D7C6FF"
  },
  "focus": {
    "outlineWidth": 2,
    "outlineOffset": 3,
    "outlineColor": "#461528",
    "restore": "returning overlays restore focus to invoker",
    "trap": "modal and sheet only",
    "shadowRole": "supplemental-only-never-the-sole-focus-indicator",
    "darkViewerOutlineColor": "#D7C6FF",
    "rule": "light UI always uses the solid burgundy outline; dark viewer always uses darkViewerOutlineColor"
  },
  "motion": {
    "durationFast": 120,
    "durationBase": 180,
    "durationSlow": 320,
    "easing": "cubic-bezier(.2,.8,.2,1)",
    "reducedMotion": "remove scale, parallax, auto-pan and continuous glow; retain instant state change and opacity <=120ms"
  },
  "component": {
    "primaryCta": {
      "background": "primaryGradient",
      "foreground": "#461528",
      "border": "#461528",
      "borderWidth": 1,
      "shadow": "card",
      "maxPerPage": 1
    },
    "secondaryButton": {
      "background": "#FFFFFF",
      "foreground": "#461528",
      "border": "#A57E75"
    },
    "dangerButton": {
      "background": "#FFFFFF",
      "foreground": "#A43E4A",
      "border": "#C0707A"
    },
    "field": {
      "background": "#FFFFFF",
      "foreground": "#321722",
      "border": "#A57E75"
    },
    "selectionControl": {
      "foreground": "#321722",
      "border": "#A57E75"
    },
    "iconButton": {
      "foreground": "#461528",
      "border": "#A57E75"
    },
    "card": {
      "background": "#FFFFFF",
      "border": "#E9DDDA",
      "interactiveBorder": "#A57E75",
      "radius": 20,
      "shadow": "card"
    },
    "status": {
      "shape": "pill",
      "usesColorAlone": false
    }
  },
  "nonTextContrast": {
    "minimumRatio": 3,
    "rule": "Every boundary required to identify an interactive control or state MUST use an accessible boundary token; decorative color.border is not sufficient.",
    "lightRequiredBoundary": "#A57E75",
    "dangerRequiredBoundary": "#C0707A",
    "darkViewerRequiredBoundary": "#8C6877",
    "primaryCtaBoundary": "#461528",
    "proof": "UI-SYSTEM-SPEC.md#non-text-contrast-evidence"
  }
};
export const actionApi = {
  "HOME.OPEN_SPACE": {
    "endpoint": "/open",
    "method": "NAVIGATE",
    "releaseLane": "v1",
    "stableErrors": []
  },
  "AUTH.OPEN_LOGIN": {
    "endpoint": "/login",
    "method": "NAVIGATE",
    "releaseLane": "v1",
    "stableErrors": []
  },
  "AUTH.REQUEST_CODE": {
    "endpoint": "/v1/auth/email-otp-challenges",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "validation_failed",
      "rate_limited",
      "authentication_failed"
    ]
  },
  "AUTH.VERIFY_CODE": {
    "endpoint": "/v1/auth/email-otp-verifications",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "validation_failed",
      "rate_limited",
      "authentication_failed"
    ]
  },
  "AUTH.LOGOUT": {
    "endpoint": "/v1/auth/logout",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "session_unavailable",
      "idempotency_conflict",
      "rate_limited"
    ]
  },
  "AUTH.LOGOUT_ALL": {
    "endpoint": "/v1/auth/logout-all",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "session_unavailable",
      "reauth_required",
      "reauth_unavailable",
      "version_conflict",
      "idempotency_conflict",
      "rate_limited"
    ]
  },
  "AUTH.REAUTH_REQUEST_CODE": {
    "endpoint": "/v1/auth/reauth-challenges",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "session_unavailable",
      "reauth_challenge_unavailable",
      "rate_limited",
      "idempotency_conflict"
    ]
  },
  "AUTH.REAUTHENTICATE": {
    "endpoint": "/v1/auth/reauth-verifications",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "authentication_failed",
      "session_unavailable",
      "reauth_challenge_unavailable",
      "rate_limited",
      "idempotency_conflict"
    ]
  },
  "MY_SPACES.OPEN": {
    "endpoint": "/v1/me/spaces",
    "method": "GET",
    "releaseLane": "v1",
    "stableErrors": [
      "session_unavailable",
      "resource_unavailable",
      "rate_limited"
    ]
  },
  "MY_SPACES.OPEN_ARCHIVED": {
    "endpoint": "/v1/me/spaces?lifecycle=archived",
    "method": "GET",
    "releaseLane": "v1",
    "stableErrors": [
      "session_unavailable",
      "resource_unavailable",
      "rate_limited"
    ]
  },
  "SPACE.OPEN_CREATE": {
    "endpoint": "/spaces/new",
    "method": "NAVIGATE",
    "releaseLane": "v1",
    "stableErrors": [
      "route_unavailable"
    ]
  },
  "SPACE.CREATE": {
    "endpoint": "/v1/spaces",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "validation_failed",
      "notice_acknowledgement_required",
      "scene_initialization_failed",
      "authorization_changed",
      "version_conflict",
      "idempotency_conflict",
      "rate_limited"
    ]
  },
  "SPACE.OPEN": {
    "endpoint": "/s/{spaceId}",
    "method": "NAVIGATE",
    "releaseLane": "v1",
    "stableErrors": [
      "route_unavailable"
    ]
  },
  "INVITATION.EXCHANGE": {
    "endpoint": "workflow:external-campaign-admission-and-per-visitor-exchange",
    "method": "WORKFLOW",
    "releaseLane": "v1",
    "stableErrors": [
      "campaign_unavailable",
      "invite_unavailable"
    ]
  },
  "INVITATION.SCAN_AGAIN": {
    "endpoint": "/open",
    "method": "NAVIGATE",
    "releaseLane": "v1",
    "stableErrors": [
      "camera_unavailable",
      "qr_unrecognized"
    ]
  },
  "INVITATION.COPY_LINK": {
    "endpoint": "client:clipboard",
    "method": "CLIPBOARD_WRITE",
    "releaseLane": "v1",
    "stableErrors": [
      "clipboard_unavailable",
      "clipboard_permission_denied",
      "invitation_link_unavailable"
    ]
  },
  "INVITATION.SHOW_QR": {
    "endpoint": "client:local-qrcode-renderer",
    "method": "LOCAL_RENDER",
    "releaseLane": "v1",
    "stableErrors": [
      "campaign_share_unavailable",
      "qr_render_unavailable"
    ]
  },
  "VIEW.OPEN_ALBUM": {
    "endpoint": "/v1/viewer/spaces/{sid}",
    "method": "GET",
    "releaseLane": "v1",
    "stableErrors": [
      "session_unavailable",
      "resource_unavailable",
      "rate_limited"
    ]
  },
  "VIEW.OPEN_SCENE": {
    "endpoint": "/v1/viewer/spaces/{sid}",
    "method": "GET",
    "releaseLane": "v1",
    "stableErrors": [
      "session_unavailable",
      "resource_unavailable",
      "scene_unavailable",
      "rate_limited"
    ]
  },
  "PHOTO.OPEN_DETAIL": {
    "endpoint": "/v1/viewer/spaces/{sid}/photos/{pid}",
    "method": "GET",
    "releaseLane": "v1",
    "stableErrors": [
      "session_unavailable",
      "resource_unavailable",
      "rate_limited"
    ]
  },
  "PHOTO.RETURN_TO_SCENE": {
    "endpoint": "/v1/viewer/spaces/{sid}/photos/{pid}/scene-context",
    "method": "GET",
    "releaseLane": "v1",
    "stableErrors": [
      "session_unavailable",
      "photo_scene_unavailable",
      "scene_unavailable",
      "rate_limited"
    ]
  },
  "UPLOAD.ACCEPT_NOTICE": {
    "endpoint": "/v1/consent-events",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "session_unavailable",
      "notice_version_stale",
      "consent_required",
      "rate_limited",
      "idempotency_conflict"
    ]
  },
  "UPLOAD.OPEN": {
    "endpoint": "/s/{spaceId}/upload",
    "method": "NAVIGATE",
    "releaseLane": "v1",
    "stableErrors": [
      "route_unavailable",
      "upload_unavailable"
    ]
  },
  "UPLOAD.SELECT_FILES": {
    "endpoint": "/v1/spaces/{sid}/contribution-batches",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "session_unavailable",
      "upload_unavailable",
      "consent_required",
      "media_limit_exceeded",
      "rate_limited",
      "idempotency_conflict"
    ]
  },
  "UPLOAD.REMOVE_ITEM": {
    "endpoint": "/v1/contribution-batches/{bid}/items/{iid}",
    "method": "DELETE",
    "releaseLane": "v1",
    "stableErrors": [
      "batch_unavailable",
      "item_unavailable",
      "item_state_conflict",
      "batch_access_unavailable",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "UPLOAD.RETRY_ITEM": {
    "endpoint": "/v1/contribution-batches/{bid}/items/{iid}/retries",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "batch_unavailable",
      "batch_finalized",
      "item_unavailable",
      "item_state_conflict",
      "upload_unavailable",
      "batch_access_unavailable",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "UPLOAD.FINALIZE_BATCH": {
    "endpoint": "/v1/contribution-batches/{bid}/finalizations",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "batch_unavailable",
      "no_terminal_items",
      "items_changed",
      "batch_finalized",
      "batch_access_unavailable",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "BATCH.OPEN_RESULT": {
    "endpoint": "/v1/batch-receipt",
    "method": "GET",
    "releaseLane": "v1",
    "stableErrors": [
      "receipt_session_unavailable",
      "batch_unavailable",
      "batch_access_unavailable",
      "rate_limited"
    ]
  },
  "BATCH.OPEN_ITEM": {
    "endpoint": "/v1/batch-receipt/items/{itemId}",
    "method": "GET",
    "releaseLane": "v1",
    "stableErrors": [
      "receipt_session_unavailable",
      "batch_item_unavailable",
      "batch_access_unavailable",
      "rate_limited"
    ]
  },
  "BATCH_RECEIPT.EXCHANGE": {
    "endpoint": "/v1/batch-receipt-exchanges",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "receipt_unavailable",
      "batch_access_unavailable"
    ]
  },
  "BATCH_BINDING.REQUEST_CODE": {
    "endpoint": "/v1/batch-receipt/account-binding-otp-challenges",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "receipt_session_unavailable",
      "binding_challenge_unavailable",
      "recovery_window_closed",
      "batch_access_unavailable",
      "rate_limited",
      "idempotency_conflict"
    ]
  },
  "BATCH_BINDING.CONFIRM": {
    "endpoint": "/v1/batch-receipt/account-bindings",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "receipt_session_unavailable",
      "verification_failed",
      "notice_acknowledgement_required",
      "binding_unavailable",
      "recovery_window_closed",
      "batch_access_unavailable",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "BATCH.OPEN_ACCOUNT_UPLOADS": {
    "endpoint": "/v1/me/batch-receipt-bindings",
    "method": "GET",
    "releaseLane": "v1",
    "stableErrors": [
      "session_unavailable",
      "account_uploads_unavailable",
      "rate_limited"
    ]
  },
  "BATCH.RECOVER_FROM_ACCOUNT": {
    "endpoint": "/v1/me/batch-receipt-recoveries",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "binding_unavailable",
      "receipt_recovery_unavailable",
      "batch_access_unavailable",
      "reauth_required",
      "rate_limited",
      "idempotency_conflict"
    ]
  },
  "BATCH_RECEIPT.REVOKE": {
    "endpoint": "/v1/batch-receipt/revocations",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "receipt_session_unavailable",
      "receipt_revocation_unavailable",
      "batch_access_unavailable",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "BATCH.DELETE_ITEM": {
    "endpoint": "/v1/photos/{pid}/deletion-requests",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "photo_unavailable",
      "deletion_not_allowed",
      "reauth_required",
      "batch_access_unavailable",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "PLACEMENT.RETRY": {
    "endpoint": "/v1/photos/{pid}/placement-actions",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "placement_action_unavailable",
      "placement_write_locked",
      "authorization_changed",
      "stale_revision",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "PLACEMENT.CONFIRM": {
    "endpoint": "/v1/photos/{pid}/placement-revisions",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "placement_action_unavailable",
      "placement_write_locked",
      "authorization_changed",
      "stale_revision",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "PLACEMENT.OPEN_EDITOR": {
    "endpoint": "/v1/photos/{pid}/placement-edit",
    "method": "GET",
    "releaseLane": "v1",
    "stableErrors": [
      "placement_edit_unavailable",
      "placement_write_locked",
      "session_unavailable",
      "rate_limited"
    ]
  },
  "PLACEMENT.SAVE": {
    "endpoint": "/v1/photos/{pid}/placement-revisions",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "placement_action_unavailable",
      "placement_write_locked",
      "authorization_changed",
      "stale_revision",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "PLACEMENT.UNDO": {
    "endpoint": "/v1/photos/{pid}/placement-actions",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "placement_action_unavailable",
      "placement_write_locked",
      "authorization_changed",
      "stale_revision",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "PLACEMENT.MARK_OUTSIDE": {
    "endpoint": "/v1/photos/{pid}/placement-actions",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "placement_action_unavailable",
      "placement_write_locked",
      "authorization_changed",
      "stale_revision",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "PLACEMENT.REOPEN_FOR_CONTRIBUTOR": {
    "endpoint": "/v1/batch-receipts/{rid}/items/{iid}/placement-reopens",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "item_unavailable",
      "owner_required",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "NOTE.OPT_IN": {
    "endpoint": "/v2-experiments/batch-receipt/items/{iid}/scene-note-jobs",
    "method": "POST",
    "releaseLane": "L2",
    "stableErrors": [
      "experiment_unavailable",
      "consent_required",
      "item_unavailable",
      "rate_limited",
      "idempotency_conflict"
    ]
  },
  "NOTE.CONFIRM": {
    "endpoint": "/v2-experiments/batch-receipt/items/{iid}/scene-note-confirmations",
    "method": "POST",
    "releaseLane": "L2",
    "stableErrors": [
      "experiment_unavailable",
      "draft_unavailable",
      "consent_required",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "NOTE.WITHDRAW": {
    "endpoint": "/v2-experiments/batch-receipt/items/{iid}/scene-note-withdrawals",
    "method": "POST",
    "releaseLane": "L2",
    "stableErrors": [
      "experiment_unavailable",
      "scene_note_unavailable",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "MANAGE.OPEN": {
    "endpoint": "/v1/spaces/{sid}/management",
    "method": "GET",
    "releaseLane": "v1",
    "stableErrors": [
      "session_unavailable",
      "resource_unavailable",
      "rate_limited"
    ]
  },
  "MANAGE.OPEN_NEXT": {
    "endpoint": "/v1/spaces/{sid}/management/next-target",
    "method": "GET",
    "releaseLane": "v1",
    "stableErrors": [
      "session_unavailable",
      "resource_unavailable",
      "authorization_changed",
      "concurrent_change",
      "invalid_queue_kind",
      "rate_limited"
    ]
  },
  "CONTENT.APPROVE": {
    "endpoint": "/v1/photos/{pid}/content-transitions",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "transition_not_allowed",
      "decision_reason_not_allowed",
      "authorization_changed",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "CONTENT.HIDE": {
    "endpoint": "/v1/photos/{pid}/content-transitions",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "transition_not_allowed",
      "decision_reason_required",
      "decision_reason_not_allowed",
      "decision_note_required",
      "authorization_changed",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "CONTENT.REJECT": {
    "endpoint": "/v1/photos/{pid}/content-transitions",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "transition_not_allowed",
      "decision_reason_required",
      "decision_reason_not_allowed",
      "decision_note_required",
      "authorization_changed",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "CONTENT.RESTORE": {
    "endpoint": "/v1/photos/{pid}/content-transitions",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "transition_not_allowed",
      "decision_reason_required",
      "decision_reason_not_allowed",
      "decision_note_required",
      "authorization_changed",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "CONTENT.REOPEN": {
    "endpoint": "/v1/photos/{pid}/content-transitions",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "transition_not_allowed",
      "decision_reason_required",
      "decision_reason_not_allowed",
      "decision_note_required",
      "authorization_changed",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "PANORAMA.UPLOAD_CANDIDATE": {
    "endpoint": "workflow:PANORAMA_CANDIDATE_UPLOAD",
    "method": "WORKFLOW",
    "releaseLane": "v1",
    "stableErrors": [
      "scene_management_unavailable",
      "notice_acknowledgement_required",
      "panorama_media_policy_invalid",
      "panorama_upload_unavailable",
      "panorama_object_missing",
      "panorama_object_mismatch",
      "panorama_decode_rejected",
      "panorama_candidate_unavailable",
      "panorama_retry_not_allowed",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "PANORAMA.SWITCH_CANDIDATE": {
    "endpoint": "/v1/spaces/{sid}/panorama-switches",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "panorama_revision_unavailable",
      "panorama_not_ready",
      "scene_version_conflict",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "PANORAMA.ROLLBACK": {
    "endpoint": "/v1/spaces/{sid}/panorama-switches",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "panorama_revision_unavailable",
      "panorama_not_ready",
      "scene_version_conflict",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "EXTERNAL_INVITATION.CREATE": {
    "endpoint": "/v1/spaces/{sid}/external-invitation-campaigns",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "campaign_policy_invalid",
      "space_state_conflict",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "EXTERNAL_INVITATION.REVOKE": {
    "endpoint": "/v1/external-invitation-campaigns/{cid}/revocations",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "campaign_management_unavailable",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "MEMBER_INVITATION.CREATE": {
    "endpoint": "/v1/spaces/{sid}/member-invitations",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "owner_required",
      "target_identifier_invalid",
      "member_invitation_conflict",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "MEMBER_INVITATION.ACCEPT": {
    "endpoint": "/v1/member-invitation-acceptances",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "member_invite_unavailable",
      "idempotency_conflict"
    ]
  },
  "MEMBER_INVITATION.REVOKE": {
    "endpoint": "/v1/member-invitations/{iid}/revocations",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "owner_required",
      "member_invitation_unavailable",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "MEMBERSHIP.UPDATE": {
    "endpoint": "/v1/spaces/{sid}/memberships/{mid}",
    "method": "PATCH",
    "releaseLane": "v1",
    "stableErrors": [
      "owner_required",
      "membership_unavailable",
      "membership_policy_invalid",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "MEMBERSHIP.REVOKE": {
    "endpoint": "/v1/spaces/{sid}/memberships/{mid}",
    "method": "DELETE",
    "releaseLane": "v1",
    "stableErrors": [
      "owner_required",
      "membership_unavailable",
      "owner_membership_immutable",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "COLLECTION.PAUSE": {
    "endpoint": "/v1/spaces/{sid}/collection-transitions",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "owner_required",
      "transition_not_allowed",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "COLLECTION.RESUME": {
    "endpoint": "/v1/spaces/{sid}/collection-transitions",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "owner_required",
      "transition_not_allowed",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "SHARING.ENABLE": {
    "endpoint": "/v1/spaces/{sid}/sharing-transitions",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "sharing_management_unavailable",
      "transition_not_allowed",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "SHARING.DISABLE": {
    "endpoint": "/v1/spaces/{sid}/sharing-transitions",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "sharing_management_unavailable",
      "transition_not_allowed",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "SPACE.ARCHIVE": {
    "endpoint": "/v1/spaces/{sid}/archive",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "owner_required",
      "reauth_required",
      "transition_not_allowed",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "SPACE.RESTORE": {
    "endpoint": "/v1/spaces/{sid}/unarchive",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "owner_required",
      "reauth_required",
      "transition_not_allowed",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "SPACE.EXPORT": {
    "endpoint": "/v1/exports",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "owner_required",
      "export_unavailable",
      "reauth_required",
      "rate_limited",
      "idempotency_conflict"
    ]
  },
  "SPACE.DELETE_REQUEST": {
    "endpoint": "/v1/spaces/{sid}/deletion-requests",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "owner_required",
      "reauth_required",
      "deletion_not_allowed",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "ACCOUNT.OPEN": {
    "endpoint": "/v1/me",
    "method": "GET",
    "releaseLane": "v1",
    "stableErrors": [
      "session_unavailable",
      "account_unavailable",
      "rate_limited"
    ]
  },
  "ACCOUNT.EXPORT": {
    "endpoint": "/v1/exports",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "session_unavailable",
      "export_unavailable",
      "rate_limited",
      "idempotency_conflict"
    ]
  },
  "ACCOUNT.DELETE_REQUEST": {
    "endpoint": "/v1/me/deletion-requests",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "reauth_required",
      "owner_disposition_required",
      "deletion_not_allowed",
      "deletion_status_session_unavailable",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "OWNER_TRANSFER.CREATE": {
    "endpoint": "/v1/spaces/{sid}/owner-transfers",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "owner_required",
      "reauth_required",
      "target_membership_invalid",
      "transfer_conflict",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "OWNER_TRANSFER.ACCEPT": {
    "endpoint": "/v1/owner-transfer-acceptances",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "owner_transfer_unavailable",
      "reauth_required",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "OWNER_TRANSFER.REVOKE": {
    "endpoint": "/v1/owner-transfers/{tid}/revocations",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "owner_required",
      "owner_transfer_unavailable",
      "version_conflict",
      "idempotency_conflict"
    ]
  },
  "EXPORT.OPEN_STATUS": {
    "endpoint": "/v1/exports/{eid}",
    "method": "GET",
    "releaseLane": "v1",
    "stableErrors": [
      "export_unavailable",
      "session_unavailable",
      "rate_limited"
    ]
  },
  "EXPORT.DOWNLOAD": {
    "endpoint": "/v1/exports/{eid}/download-authorizations",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "export_unavailable",
      "export_not_ready",
      "download_expired",
      "session_unavailable",
      "rate_limited",
      "idempotency_conflict"
    ]
  },
  "DELETION.OPEN_STATUS": {
    "endpoint": "/v1/deletion-requests/{did}",
    "method": "GET",
    "releaseLane": "v1",
    "stableErrors": [
      "deletion_request_unavailable",
      "rate_limited"
    ]
  },
  "REPORT.SUBMIT": {
    "endpoint": "/v1/reports",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "case_submission_unavailable",
      "notice_acknowledgement_required",
      "object_context_unavailable",
      "unsupported_field",
      "rate_limited",
      "idempotency_conflict"
    ]
  },
  "REPORT.OPEN_STATUS": {
    "endpoint": "/v1/reports/{caseId}",
    "method": "GET",
    "releaseLane": "v1",
    "stableErrors": [
      "case_unavailable",
      "rate_limited"
    ]
  },
  "APPEAL.SUBMIT": {
    "endpoint": "/v1/appeals",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "appeal_submission_unavailable",
      "notice_acknowledgement_required",
      "case_unavailable",
      "unsupported_field",
      "rate_limited",
      "idempotency_conflict"
    ]
  },
  "APPEAL.OPEN_STATUS": {
    "endpoint": "/v1/appeals/{caseId}",
    "method": "GET",
    "releaseLane": "v1",
    "stableErrors": [
      "case_unavailable",
      "rate_limited"
    ]
  },
  "SUPPORT.OPEN": {
    "endpoint": "/support",
    "method": "GET",
    "releaseLane": "v1",
    "stableErrors": [
      "resource_unavailable"
    ]
  },
  "SUPPORT.SUBMIT_SAFETY_LEAD": {
    "endpoint": "/v1/support-cases",
    "method": "POST",
    "releaseLane": "v1",
    "stableErrors": [
      "support_submission_unavailable",
      "unsupported_field",
      "rate_limited",
      "idempotency_conflict"
    ]
  },
  "SUPPORT.OPEN_STATUS": {
    "endpoint": "/v1/support-cases/{caseId}",
    "method": "GET",
    "releaseLane": "v1",
    "stableErrors": [
      "case_unavailable",
      "rate_limited"
    ]
  },
  "MEDIA_NOTICE.OPEN": {
    "endpoint": "/v1/notices/current?purpose=photo_upload",
    "method": "GET",
    "releaseLane": "v1",
    "stableErrors": [
      "session_unavailable",
      "upload_unavailable",
      "notice_unavailable",
      "rate_limited"
    ]
  },
  "LEGAL.OPEN_PRIVACY": {
    "endpoint": "/privacy",
    "method": "GET",
    "releaseLane": "v1",
    "stableErrors": [
      "resource_unavailable"
    ]
  },
  "LEGAL.OPEN_TERMS": {
    "endpoint": "/terms",
    "method": "GET",
    "releaseLane": "v1",
    "stableErrors": [
      "resource_unavailable"
    ]
  }
};
