-- Up Migration
-- The sign-in library's tables, in their own schema. The SQL between the markers was produced by
-- `npm run auth:schema` (better-auth 1.7.2), reviewed and committed. The library's own migrate command
-- is never run, and the application role cannot create or alter tables.
create schema auth;
grant usage on schema auth to mkt_app;
set local search_path to auth;

-- BEGIN generated
create table "user" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null, "twoFactorEnabled" boolean);

create table "session" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" uuid not null references "user" ("id") on delete cascade);

create table "account" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "issuer" text not null, "accountId" text not null, "providerId" text not null, "userId" uuid not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null);

create table "verification" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table "twoFactor" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "secret" text not null, "backupCodes" text not null, "userId" uuid not null references "user" ("id") on delete cascade, "verified" boolean, "failedVerificationCount" integer, "lockedUntil" timestamptz);

create index "session_userId_idx" on "session" ("userId");

create index "account_userId_idx" on "account" ("userId");

create index "verification_identifier_idx" on "verification" ("identifier");

create index "twoFactor_secret_idx" on "twoFactor" ("secret");

create index "twoFactor_userId_idx" on "twoFactor" ("userId");

create unique index "account_issuer_accountId_uidx" on "account" ("issuer", "accountId");
-- END generated
-- Back to the default, so nothing after this (or a later migration run in the same transaction, as the
-- node-pg-migrate command line does by default) lands in auth.
set local search_path to default;

grant select, insert, update, delete on all tables in schema auth to mkt_app;

-- Our tables refer to a user by the library's user ID (database schema, section 4).
alter table app.platform_owner add constraint platform_owner_user_fk foreign key (user_id) references auth."user" (id);
alter table app.platform_owner add constraint platform_owner_granted_by_fk foreign key (granted_by) references auth."user" (id);
alter table app.membership add constraint membership_user_fk foreign key (user_id) references auth."user" (id);
alter table app.membership add constraint membership_created_by_fk foreign key (created_by) references auth."user" (id);
alter table app.invite add constraint invite_invited_by_fk foreign key (invited_by) references auth."user" (id);
alter table app.approval_setting add constraint approval_setting_updated_by_fk foreign key (updated_by) references auth."user" (id);
alter table app.approval add constraint approval_decided_by_fk foreign key (decided_by) references auth."user" (id);
alter table app.approval_request add constraint approval_request_escalated_to_fk foreign key (escalated_to) references auth."user" (id);

-- Down Migration
alter table app.approval_request drop constraint approval_request_escalated_to_fk;
alter table app.approval drop constraint approval_decided_by_fk;
alter table app.approval_setting drop constraint approval_setting_updated_by_fk;
alter table app.invite drop constraint invite_invited_by_fk;
alter table app.membership drop constraint membership_created_by_fk;
alter table app.membership drop constraint membership_user_fk;
alter table app.platform_owner drop constraint platform_owner_granted_by_fk;
alter table app.platform_owner drop constraint platform_owner_user_fk;
drop schema auth cascade;
