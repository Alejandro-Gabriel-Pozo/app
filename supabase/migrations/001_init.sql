-- Resources table
CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Reservations table
CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  start_time TIMESTAMP WITH TIME ZONE NOT NULL,
  end_time TIMESTAMP WITH TIME ZONE NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  details JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_reservations_resource_id ON reservations(resource_id);
CREATE INDEX idx_reservations_resource_type ON reservations(resource_type);
CREATE INDEX idx_reservations_status ON reservations(status);
CREATE INDEX idx_reservations_start_time ON reservations(start_time);
CREATE INDEX idx_reservations_end_time ON reservations(end_time);
CREATE INDEX idx_reservations_customer_id ON reservations(customer_id);

-- Function for underutilized resources
CREATE OR REPLACE FUNCTION get_underutilized_resources(
  p_resource_type TEXT,
  p_min_occupancy INTEGER,
  p_start_date TIMESTAMP WITH TIME ZONE,
  p_end_date TIMESTAMP WITH TIME ZONE
)
RETURNS TABLE (
  resource_id TEXT,
  occupancy_percent INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    r.id,
    CAST(
      COALESCE(
        SUM(EXTRACT(EPOCH FROM (
          LEAST(res.end_time, p_end_date::timestamp with time zone) - 
          GREATEST(res.start_time, p_start_date::timestamp with time zone)
        ))) / 
        EXTRACT(EPOCH FROM (p_end_date::timestamp with time zone - p_start_date::timestamp with time zone)) * 100,
        0
      ) AS INTEGER
    ) AS occupancy_percentage
  FROM resources r
  LEFT JOIN reservations res ON r.id = res.resource_id 
    AND res.status IN ('CONFIRMED', 'COMPLETED')
    AND res.end_time > p_start_date::timestamp with time zone
    AND res.start_time < p_end_date::timestamp with time zone
  WHERE r.type = p_resource_type
  GROUP BY r.id
  HAVING CAST(
    COALESCE(
      SUM(EXTRACT(EPOCH FROM (
        LEAST(res.end_time, p_end_date::timestamp with time zone) - 
        GREATEST(res.start_time, p_start_date::timestamp with time zone)
      ))) / 
      EXTRACT(EPOCH FROM (p_end_date::timestamp with time zone - p_start_date::timestamp with time zone)) * 100,
      0
    ) AS INTEGER
  ) < p_min_occupancy
  ORDER BY occupancy_percentage DESC;
END;
$$ LANGUAGE plpgsql;
