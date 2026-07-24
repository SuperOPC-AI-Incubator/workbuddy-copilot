-- Prevent the legacy ACK function from racing the one-time repair. A call
-- already waiting on this table resumes under the CHECK constraint below.
LOCK TABLE public.mentor_message_deliveries IN ACCESS EXCLUSIVE MODE;

-- The previous RPC allowed an owned message ID to be acknowledged before its
-- first fetch. Requeue only that impossible delivery state: at-least-once
-- repetition is safer than preserving an acknowledgement that cannot prove a
-- display ever happened.
UPDATE public.mentor_message_deliveries
SET acknowledged_at = NULL
WHERE acknowledged_at IS NOT NULL
  AND first_fetched_at IS NULL;

ALTER TABLE public.mentor_message_deliveries
  ADD CONSTRAINT mentor_message_deliveries_ack_requires_fetch_check
  CHECK (
    acknowledged_at IS NULL
    OR first_fetched_at IS NOT NULL
  );

CREATE OR REPLACE FUNCTION public.ack_workbuddy_mentor_messages(
  _student_id uuid,
  _message_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  eligible_count integer;
  result jsonb;
BEGIN
  IF _student_id IS NULL
    OR _message_ids IS NULL
    OR pg_catalog.cardinality(_message_ids) NOT BETWEEN 1 AND 100
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(_message_ids) AS requested(message_id)
      WHERE requested.message_id IS NULL
    )
    OR pg_catalog.cardinality(_message_ids) <> (
      SELECT pg_catalog.count(DISTINCT requested.message_id)
      FROM pg_catalog.unnest(_message_ids) AS requested(message_id)
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P4040',
      MESSAGE = 'workbuddy_delivery_not_owned';
  END IF;

  PERFORM private.lock_workbuddy_delivery_student(_student_id);

  PERFORM 1
  FROM public.mentor_message_deliveries AS delivery
  WHERE delivery.message_id = ANY (_message_ids)
    AND delivery.student_id = _student_id
  ORDER BY delivery.message_id
  FOR UPDATE;

  SELECT pg_catalog.count(*)
  INTO eligible_count
  FROM public.mentor_message_deliveries AS delivery
  WHERE delivery.message_id = ANY (_message_ids)
    AND delivery.student_id = _student_id
    AND delivery.first_fetched_at IS NOT NULL;

  IF eligible_count <> pg_catalog.cardinality(_message_ids) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P4040',
      MESSAGE = 'workbuddy_delivery_not_owned';
  END IF;

  WITH acknowledged AS (
    UPDATE public.mentor_message_deliveries AS delivery
    SET acknowledged_at = COALESCE(
      delivery.acknowledged_at,
      pg_catalog.now()
    )
    WHERE delivery.message_id = ANY (_message_ids)
      AND delivery.student_id = _student_id
      AND delivery.first_fetched_at IS NOT NULL
    RETURNING delivery.message_id, delivery.acknowledged_at
  )
  SELECT pg_catalog.jsonb_build_object(
    'acknowledged',
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', acknowledged.message_id,
        'acknowledged_at', acknowledged.acknowledged_at
      )
      ORDER BY acknowledged.message_id
    )
  )
  INTO result
  FROM acknowledged;

  RETURN result;
END;
$function$;

REVOKE ALL ON FUNCTION public.ack_workbuddy_mentor_messages(uuid, uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ack_workbuddy_mentor_messages(uuid, uuid[])
  TO service_role;
