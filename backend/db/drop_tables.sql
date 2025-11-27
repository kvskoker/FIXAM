-- Drop existing tables and views in the correct order (reverse of dependencies)
DROP VIEW IF EXISTS issues_with_votes CASCADE;
DROP TABLE IF EXISTS issue_tracker CASCADE;
DROP TABLE IF EXISTS votes CASCADE;
DROP TABLE IF EXISTS issues CASCADE;
DROP TABLE IF EXISTS users CASCADE;
