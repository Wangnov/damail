-- 草稿箱、垃圾邮件、已删除改为默认同步，已有邮箱也一并打开
UPDATE "folders" SET "sync_enabled" = true WHERE "special_use" IN ('\Drafts', '\Junk', '\Trash') AND NOT "sync_enabled";
