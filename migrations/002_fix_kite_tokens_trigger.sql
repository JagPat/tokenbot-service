-- Fix kite_tokens table trigger issue
-- The update_updated_at_column() trigger is trying to update updated_at on kite_tokens
-- but the table doesn't have that column. We have two options:
-- 1. Add updated_at column to kite_tokens
-- 2. Remove the trigger from kite_tokens
-- We'll add the column since it's useful for tracking token updates

-- Add updated_at column if it doesn't exist
ALTER TABLE kite_tokens 
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

-- Create index on updated_at if it doesn't exist
CREATE INDEX IF NOT EXISTS idx_kite_tokens_updated_at ON kite_tokens(updated_at);

-- Drop the trigger if it exists (to recreate it properly)
DROP TRIGGER IF EXISTS update_kite_tokens_updated_at ON kite_tokens;

-- Recreate the trigger only if the column exists
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'kite_tokens' 
        AND column_name = 'updated_at'
    ) THEN
        CREATE TRIGGER update_kite_tokens_updated_at 
        BEFORE UPDATE ON kite_tokens 
        FOR EACH ROW 
        EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;









