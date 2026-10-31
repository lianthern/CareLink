export function adminPermissions(core, accountId) {
  const row = core.one(
    "SELECT is_admin,admin_role FROM account_administration WHERE account_id=?",
    accountId,
  );
  const adminRole =
    row?.is_admin === 1
      ? row.admin_role === "super_admin"
        ? "super_admin"
        : "admin"
      : "user";
  const isAdmin = adminRole !== "user",
    highest = adminRole === "super_admin";
  return {
    adminRole,
    isAdmin,
    capabilities: {
      canManageRoles: highest,
      canInspectPrivateData: highest,
      canViewFullEmails: isAdmin,
      canManageAccounts: isAdmin,
      canReviewSubmissions: isAdmin,
      canViewOperationalAudit: isAdmin,
      canReviewRecoveryRequests: highest,
      canManageRecovery: highest,
    },
  };
}
