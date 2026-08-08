-- Run after both InstaPay migrations in a disposable preview environment.
-- Expected: extension_installed/schema_available/functions_available are
-- true, extension_version is >=1.5, matching_job_count is 1, and the single
-- job is active with the exact schedule and command below.

select
  exists (
    select 1 from pg_extension where extname = 'pg_cron'
  ) as extension_installed,
  (
    select extversion from pg_extension where extname = 'pg_cron'
  ) as extension_version,
  to_regnamespace('cron') is not null as cron_schema_available,
  to_regclass('cron.job') is not null as cron_job_table_available,
  to_regprocedure('cron.schedule(text,text,text)') is not null
    and to_regprocedure('cron.unschedule(bigint)') is not null
    as cron_functions_available;

select
  jobid,
  jobname,
  schedule,
  command,
  active,
  database,
  username
from cron.job
where jobname = 'tick-instapay-expiry'
   or position('expire_instapay_orders' in lower(command)) > 0
order by jobid;

select count(*) as matching_job_count
from cron.job
where jobname = 'tick-instapay-expiry'
   or position('expire_instapay_orders' in lower(command)) > 0;

select
  jobid,
  status,
  return_message,
  start_time,
  end_time
from cron.job_run_details
where jobid in (
  select jobid from cron.job where jobname = 'tick-instapay-expiry'
)
order by start_time desc
limit 10;
