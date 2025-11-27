-- Insert Mock Users
INSERT INTO users (phone_number, name, created_at) VALUES
('23276123456', 'Mohamed Kamara', '2023-10-15 08:00:00'),
('23277234567', 'Fatmata Sesay', '2023-10-16 09:30:00'),
('23278345678', 'Ibrahim Koroma', '2023-10-17 10:15:00'),
('23279456789', 'Aminata Bangura', '2023-10-18 11:45:00'),
('23276567890', 'Abdul Rahman', '2023-10-19 13:20:00'),
('23277678901', 'Mariama Conteh', '2023-10-20 14:00:00'),
('23278789012', 'Sorie Turay', '2023-10-21 15:30:00'),
('23279890123', 'Hawa Jalloh', '2023-10-22 16:45:00');

-- Insert Mock Issues
INSERT INTO issues (title, category, status, lat, lng, description, image_url, reported_by, reported_on, created_at) VALUES
('Burst Pipe on Jomo Kenyatta Road', 'Water', 'critical', 8.4845, -13.2345, 'Large water pipe burst causing flooding in the intersection. Traffic is blocked.', 'https://images.unsplash.com/photo-1515162816999-a0c47dc192f7?auto=format&fit=crop&q=80&w=400', 1, '2023-10-27 10:30:00', '2023-10-27 10:30:00'),
('Large Pothole near Cotton Tree', 'Road', 'progress', 8.4872, -13.2356, 'Deep pothole damaging vehicles. Council workers seen surveying the area.', 'https://images.unsplash.com/photo-1515162816999-a0c47dc192f7?auto=format&fit=crop&q=80&w=400', 2, '2023-10-26 14:15:00', '2023-10-26 14:15:00'),
('Pile of Uncollected Garbage', 'Waste', 'critical', 8.4810, -13.2290, 'Garbage has not been collected for 2 weeks. Health hazard.', 'https://images.unsplash.com/photo-1530587191325-3db32d826c18?auto=format&fit=crop&q=80&w=400', 3, '2023-10-25 09:00:00', '2023-10-25 09:00:00'),
('Street Light Broken', 'Electricity', 'fixed', 8.4900, -13.2400, 'Street light was fixed yesterday. Area is now well lit.', 'https://images.unsplash.com/photo-1563251273-04780932200b?auto=format&fit=crop&q=80&w=400', 4, '2023-10-20 18:45:00', '2023-10-20 18:45:00'),
('Blocked Drainage', 'Health', 'critical', 8.4750, -13.2250, 'Stagnant water in drainage causing mosquito breeding.', 'https://images.unsplash.com/photo-1574974671999-24b7df528bf9?auto=format&fit=crop&q=80&w=400', 5, '2023-10-27 08:20:00', '2023-10-27 08:20:00'),
('Fallen Tree Blocking Road', 'Road', 'progress', 8.4860, -13.2380, 'Tree fell during the storm last night. Crews are clearing it.', 'https://images.unsplash.com/photo-1515162816999-a0c47dc192f7?auto=format&fit=crop&q=80&w=400', 6, '2023-10-27 07:00:00', '2023-10-27 07:00:00');

-- Insert Mock Votes
-- Issue 1: Burst Pipe (156 net votes)
INSERT INTO votes (issue_id, user_id, vote_type, created_at) VALUES
(1, 2, 'upvote', '2023-10-27 10:35:00'),
(1, 3, 'upvote', '2023-10-27 10:40:00'),
(1, 4, 'upvote', '2023-10-27 10:45:00'),
(1, 5, 'upvote', '2023-10-27 11:00:00'),
(1, 6, 'upvote', '2023-10-27 11:15:00'),
(1, 7, 'upvote', '2023-10-27 11:30:00'),
(1, 8, 'upvote', '2023-10-27 11:45:00');

-- Issue 2: Pothole (89 net votes)
INSERT INTO votes (issue_id, user_id, vote_type, created_at) VALUES
(2, 1, 'upvote', '2023-10-26 14:20:00'),
(2, 3, 'upvote', '2023-10-26 14:25:00'),
(2, 4, 'upvote', '2023-10-26 14:30:00'),
(2, 5, 'upvote', '2023-10-26 14:35:00'),
(2, 6, 'upvote', '2023-10-26 14:40:00');

-- Issue 3: Garbage (234 net votes)
INSERT INTO votes (issue_id, user_id, vote_type, created_at) VALUES
(3, 1, 'upvote', '2023-10-25 09:05:00'),
(3, 2, 'upvote', '2023-10-25 09:10:00'),
(3, 4, 'upvote', '2023-10-25 09:15:00'),
(3, 5, 'upvote', '2023-10-25 09:20:00'),
(3, 6, 'upvote', '2023-10-25 09:25:00'),
(3, 7, 'upvote', '2023-10-25 09:30:00'),
(3, 8, 'upvote', '2023-10-25 09:35:00');

-- Issue 4: Street Light (45 net votes)
INSERT INTO votes (issue_id, user_id, vote_type, created_at) VALUES
(4, 1, 'upvote', '2023-10-20 18:50:00'),
(4, 2, 'upvote', '2023-10-20 18:55:00'),
(4, 3, 'upvote', '2023-10-20 19:00:00');

-- Issue 5: Blocked Drainage (112 net votes)
INSERT INTO votes (issue_id, user_id, vote_type, created_at) VALUES
(5, 1, 'upvote', '2023-10-27 08:25:00'),
(5, 2, 'upvote', '2023-10-27 08:30:00'),
(5, 3, 'upvote', '2023-10-27 08:35:00'),
(5, 4, 'upvote', '2023-10-27 08:40:00'),
(5, 6, 'upvote', '2023-10-27 08:45:00'),
(5, 7, 'upvote', '2023-10-27 08:50:00');

-- Issue 6: Fallen Tree (67 net votes)
INSERT INTO votes (issue_id, user_id, vote_type, created_at) VALUES
(6, 1, 'upvote', '2023-10-27 07:05:00'),
(6, 2, 'upvote', '2023-10-27 07:10:00'),
(6, 3, 'upvote', '2023-10-27 07:15:00'),
(6, 4, 'upvote', '2023-10-27 07:20:00');

-- Insert Issue Tracker Logs
-- Issue 1: Burst Pipe
INSERT INTO issue_tracker (issue_id, action, description, performed_by, created_at) VALUES
(1, 'reported', 'Issue reported by citizen', 1, '2023-10-27 10:30:00'),
(1, 'acknowledged', 'Issue acknowledged by water department', NULL, '2023-10-27 10:45:00'),
(1, 'assigned', 'Assigned to repair crew #5', NULL, '2023-10-27 11:00:00');

-- Issue 2: Pothole
INSERT INTO issue_tracker (issue_id, action, description, performed_by, created_at) VALUES
(2, 'reported', 'Issue reported by citizen', 2, '2023-10-26 14:15:00'),
(2, 'acknowledged', 'Issue acknowledged by roads department', NULL, '2023-10-26 14:30:00'),
(2, 'in_progress', 'Survey completed, repair scheduled', NULL, '2023-10-27 09:00:00');

-- Issue 3: Garbage
INSERT INTO issue_tracker (issue_id, action, description, performed_by, created_at) VALUES
(3, 'reported', 'Issue reported by citizen', 3, '2023-10-25 09:00:00'),
(3, 'acknowledged', 'Issue acknowledged by waste management', NULL, '2023-10-25 10:00:00'),
(3, 'escalated', 'Escalated due to high vote count', NULL, '2023-10-26 08:00:00');

-- Issue 4: Street Light (Fixed)
INSERT INTO issue_tracker (issue_id, action, description, performed_by, created_at) VALUES
(4, 'reported', 'Issue reported by citizen', 4, '2023-10-20 18:45:00'),
(4, 'acknowledged', 'Issue acknowledged by electricity department', NULL, '2023-10-20 19:00:00'),
(4, 'assigned', 'Assigned to electrician crew', NULL, '2023-10-21 08:00:00'),
(4, 'in_progress', 'Repair work started', NULL, '2023-10-21 14:00:00'),
(4, 'resolved', 'Street light repaired and tested', NULL, '2023-10-21 16:30:00'),
(4, 'verified', 'Repair verified by supervisor', NULL, '2023-10-21 17:00:00');

-- Issue 5: Blocked Drainage
INSERT INTO issue_tracker (issue_id, action, description, performed_by, created_at) VALUES
(5, 'reported', 'Issue reported by citizen', 5, '2023-10-27 08:20:00'),
(5, 'acknowledged', 'Issue acknowledged by health department', NULL, '2023-10-27 08:45:00');

-- Issue 6: Fallen Tree
INSERT INTO issue_tracker (issue_id, action, description, performed_by, created_at) VALUES
(6, 'reported', 'Issue reported by citizen', 6, '2023-10-27 07:00:00'),
(6, 'acknowledged', 'Issue acknowledged by roads department', NULL, '2023-10-27 07:15:00'),
(6, 'assigned', 'Assigned to emergency clearing crew', NULL, '2023-10-27 07:30:00'),
(6, 'in_progress', 'Tree removal in progress', NULL, '2023-10-27 08:00:00');
