-- Up Migration
-- Read, verify and export-record functions for the audit log. The readers belong to the owner-view role
-- (spec 6: "audit: read through functions"); recording that an export happened belongs to the audit-writer
-- role. They are the daily export and verify jobs' only way in. A person's read through the screen is logged
-- by the dashboard milestone; these two system readers are not logged, because they read everything daily.

grant create on schema audit to mkt_definer;

create function audit.chain_heads()
returns table (chain_key text, head_seq bigint, head_hash text)
language sql security definer stable set search_path = pg_catalog, audit
as $$
  select distinct on (l.chain_key) l.chain_key, l.seq, l.hash from audit.log l order by l.chain_key, l.seq desc
$$;

create function audit.entries_after(p_chain text, p_after bigint, p_limit integer)
returns setof audit.log
language sql security definer stable set search_path = pg_catalog, audit
as $$
  select * from audit.log l where l.chain_key = p_chain and l.seq > p_after order by l.seq limit least(greatest(p_limit, 1), 10000)
$$;

create function audit.hash_at(p_chain text, p_seq bigint)
returns text
language sql security definer stable set search_path = pg_catalog, audit
as $$ select l.hash from audit.log l where l.chain_key = p_chain and l.seq = p_seq $$;

-- Recomputes the whole chain: sequence numbers 1, 2, 3 ... with none missing, each previous hash equal to the
-- hash before it, and each hash equal to the hash of the entry's own content.
create function audit.verify_chain(p_chain text)
returns table (ok boolean, checked bigint, broken_at bigint, head_hash text)
language plpgsql security definer stable set search_path = pg_catalog, audit
as $$
declare
  r audit.log%rowtype;
  v_expect bigint := 1;
  v_prev text := null;
  v_n bigint := 0;
begin
  for r in select * from audit.log l where l.chain_key = p_chain order by l.seq loop
    if r.seq <> v_expect
       or r.prev_hash is distinct from v_prev
       or r.hash <> audit.entry_hash(r.chain_key, r.seq, r.at, r.actor_kind, r.actor_id, r.action, r.outcome,
                                     r.subject, r.detail, r.prev_hash) then
      return query select false, v_n, r.seq, v_prev;
      return;
    end if;
    v_prev := r.hash;
    v_expect := v_expect + 1;
    v_n := v_n + 1;
  end loop;
  return query select true, v_n, null::bigint, v_prev;
end $$;

create function audit.exports_for(p_chain text)
returns setof audit.export
language sql security definer stable set search_path = pg_catalog, audit
as $$ select * from audit.export e where e.chain_key = p_chain order by e.through_seq $$;

create function audit.record_export(p_chain text, p_through bigint, p_hash text, p_location text)
returns uuid
language plpgsql security definer set search_path = pg_catalog, audit
as $$
declare v_id uuid;
begin
  -- An export record states that storage outside the server holds the chain up to this entry. It must be true.
  if p_hash is distinct from (select l.hash from audit.log l where l.chain_key = p_chain and l.seq = p_through) then
    raise exception 'the export does not match the log' using errcode = '23514';
  end if;
  insert into audit.export (chain_key, through_seq, chain_hash, location)
  values (p_chain, p_through, p_hash, p_location)
  returning id into v_id;
  return v_id;
end $$;

alter function audit.chain_heads() owner to mkt_definer;
alter function audit.entries_after(text, bigint, integer) owner to mkt_definer;
alter function audit.hash_at(text, bigint) owner to mkt_definer;
alter function audit.verify_chain(text) owner to mkt_definer;
alter function audit.exports_for(text) owner to mkt_definer;
alter function audit.record_export(text, bigint, text, text) owner to mkt_definer;

revoke all on function audit.chain_heads() from public;
revoke all on function audit.entries_after(text, bigint, integer) from public;
revoke all on function audit.hash_at(text, bigint) from public;
revoke all on function audit.verify_chain(text) from public;
revoke all on function audit.exports_for(text) from public;
revoke all on function audit.record_export(text, bigint, text, text) from public;
grant execute on function audit.chain_heads() to mkt_owner_view;
grant execute on function audit.entries_after(text, bigint, integer) to mkt_owner_view;
grant execute on function audit.hash_at(text, bigint) to mkt_owner_view;
grant execute on function audit.verify_chain(text) to mkt_owner_view;
grant execute on function audit.exports_for(text) to mkt_owner_view;
grant execute on function audit.record_export(text, bigint, text, text) to mkt_audit_writer;

revoke create on schema audit from mkt_definer;

-- Down Migration
drop function audit.record_export(text, bigint, text, text);
drop function audit.exports_for(text);
drop function audit.verify_chain(text);
drop function audit.hash_at(text, bigint);
drop function audit.entries_after(text, bigint, integer);
drop function audit.chain_heads();
