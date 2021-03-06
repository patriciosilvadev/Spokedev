-- 1.1 Discover duplicates
-- -----------------------

select
  contact.id as contact_id,
  duplicate.id as duplicate_id,
  contact.cell as contact_cell,
  duplicate.cell as duplicate_cell,
  contact.campaign_id as contact_campaign_id,
  duplicate.campaign_id as duplicate_campaign_id,
  contact.assignment_id as contact_assignment_id,
  duplicate.assignment_id as duplicate_assignment_id
  -- count(*) as duplicate_count
from
  campaign_contact as contact
join
  campaign_contact as duplicate
  on
    duplicate.cell = contact.cell
    and duplicate.campaign_id = contact.campaign_id
where
  duplicate.id > contact.id
  and contact.campaign_id = 411
-- group by
--   contact_campaign_id
;


-- 1.2 Migrate messages from duplicate to contact
-- ----------------------------------------------

-- Count duplicates' messages

select
  count(*) as message_count
from
  campaign_contact as contact
join
  campaign_contact as duplicate
  on
    duplicate.cell = contact.cell
    and duplicate.campaign_id = contact.campaign_id
join
  message
  on
    message.campaign_contact_id = duplicate.id
where
  duplicate.id > contact.id
  and contact.campaign_id = 411
;

-- Migrate the messages

update
  (
    select
      contact.id as contact_id,
      duplicate.id as duplicate_id,
      contact.assignment_id as contact_assignment_id
    from
      campaign_contact as contact
    join
      campaign_contact as duplicate
      on
        duplicate.cell = contact.cell
        and duplicate.campaign_id = contact.campaign_id
    where
      duplicate.id > contact.id
      and contact.campaign_id = 411
  ) duplicates
join
  message
  on
    message.campaign_contact_id = duplicates.duplicate_id
set
  message.campaign_contact_id = duplicates.contact_id,
  message.assignment_id = duplicates.contact_assignment_id
;

-- TODO: verify count query above is 0


-- 1.3 Migrate question responses from duplicate to contact
-- --------------------------------------------------------

-- Count duplicates' question responses

select
  count(*) as response_count
from
  campaign_contact as contact
join
  campaign_contact as duplicate
  on
    duplicate.cell = contact.cell
    and duplicate.campaign_id = contact.campaign_id
join
  question_response
  on
    question_response.campaign_contact_id = duplicate.id
where
  duplicate.id > contact.id
  and contact.campaign_id = 411
;

-- Migrate the question responses

update
  (
    select
      contact.id as contact_id,
      duplicate.id as duplicate_id
    from
      campaign_contact as contact
    join
      campaign_contact as duplicate
      on
        duplicate.cell = contact.cell
        and duplicate.campaign_id = contact.campaign_id
    where
      duplicate.id > contact.id
      and contact.campaign_id = 411
  ) duplicates
join
  question_response
  on question_response.campaign_contact_id = duplicates.duplicate_id
set
  question_response.campaign_contact_id = duplicates.contact_id
;

-- TODO: verify count query above is 0


-- 1.4 Delete duplicate question responses
-- ------------------------------------------

-- Get count

select
  count(*) as duplicate_count
from
  question_response as response
join
  question_response as duplicate
  on
    response.campaign_contact_id = duplicate.campaign_contact_id
    and response.interaction_step_id = duplicate.interaction_step_id
join
  campaign_contact
  on
    campaign_contact.id = response.campaign_contact_id
where
  campaign_contact.campaign_id = 411
  and duplicate.id > response.id
;

-- Delete question responses

create temporary table
  tmp_qr
as (
    select
      duplicate.id
    from
      question_response as response
    join
      question_response as duplicate
      on
        response.campaign_contact_id = duplicate.campaign_contact_id
        and response.interaction_step_id = duplicate.interaction_step_id
    join
      campaign_contact
      on
        campaign_contact.id = response.campaign_contact_id
    where
      campaign_contact.campaign_id = 411
      and duplicate.id > response.id
  )
;

delete question_response from
  question_response
inner join
  tmp_qr
  on
    tmp_qr.id = question_response.id
;

-- TODO: verify count query above is 0

-- Remove temp table

drop table tmp_qr;


-- 1.5 Update campaign contact message_status
-- ------------------------------------------

update
  campaign_contact as contact
join
  campaign_contact as duplicate
  on
    duplicate.cell = contact.cell
    and duplicate.campaign_id = contact.campaign_id
left join
  message first_message
  on
    first_message.id = (
      select
        id
      from
        message
      where
        message.campaign_contact_id = contact.id
      order by
        created_at asc
      limit 1
    )
left join
  message last_message
  on
    last_message.id = (
      select
        id
      from
        message
      where
        message.campaign_contact_id = contact.id
      order by
        created_at desc
      limit 1
    )
set
  contact.message_status = IF (
    (contact.message_status = 'closed' or duplicate.message_status = 'closed'),
    'closed',
    IF (
      first_message.is_from_contact is null,
      'needsMessage',
      IF (
        last_message.is_from_contact,
        'needsResponse',
        IF (
          last_message.id = first_message.id,
          'messaged',
          'convo'
        )
      )
    )
  )
where
  duplicate.id > contact.id
  and contact.campaign_id = 411
;


-- 1.6 Delete duplicates
-- ---------------------

create temporary table
  tmp_dup
as (
  select
    duplicate.id as id
  from
    campaign_contact as contact
  join
    campaign_contact as duplicate
    on
      duplicate.cell = contact.cell
      and duplicate.campaign_id = contact.campaign_id
  where
    duplicate.id > contact.id
    and contact.campaign_id = 411
  )
;

delete campaign_contact from
  campaign_contact
inner join
  tmp_dup
  on
    tmp_dup.id = campaign_contact.id
;

-- TODO: verify initial discovery count is 0

-- Remove temp table

drop table tmp_dup;

-- TODO: steps 1.1 - 1.4 for other four affected campaigns


-- 2.0 Add unique constraint
-- -------------------------

alter table
  campaign_contact
add constraint
  unique_cc_campaign_id_cell
  unique (campaign_id, cell)
;
