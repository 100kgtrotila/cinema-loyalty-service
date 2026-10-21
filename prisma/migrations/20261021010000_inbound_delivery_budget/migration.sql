CREATE TABLE inbound_deliveries (
    id VARCHAR(64) PRIMARY KEY,
    operation VARCHAR(32) NOT NULL,
    source_queue VARCHAR(255) NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    quarantine_required BOOLEAN NOT NULL DEFAULT FALSE,
    quarantined_at TIMESTAMPTZ,
    error_code VARCHAR(64),
    original_body BYTEA,
    original_properties BYTEA,
    replay_id UUID,
    replay_count INTEGER NOT NULL DEFAULT 0 CHECK (replay_count >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT inbound_delivery_lease_pair CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
    CONSTRAINT inbound_delivery_quarantine_saved CHECK (
      quarantined_at IS NULL OR (original_body IS NOT NULL AND original_properties IS NOT NULL)
    )
);
CREATE INDEX inbound_deliveries_quarantined_at_idx ON inbound_deliveries(quarantined_at);
