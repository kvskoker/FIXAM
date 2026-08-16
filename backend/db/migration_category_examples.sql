-- Teach the classifier how people actually describe things.
--
-- Reports were matched against the category *name* and nothing else, so
-- "the transformer burnt" landed in Fire Services: the word "burnt" is closer
-- to "Fire Services" than to "Electricity & Power Supply" in any general
-- language model. The model was not wrong about English. It had simply never
-- been told that a burnt transformer is an electricity problem in this country.
--
-- Example phrases fix that without retraining anything. A category is now
-- matched against the way people report it, not just against its label, and
-- the examples are ordinary text an administrator can edit when the pilot
-- shows how citizens really write.
--
-- Safe to re-run.

ALTER TABLE categories ADD COLUMN IF NOT EXISTS examples TEXT;

COMMENT ON COLUMN categories.examples IS
    'Newline-separated example reports. Used alongside the category name when '
    'classifying an incoming report. Editable in the admin portal.';

-- Seeded for the pilot categories. Deliberately written the way a citizen would
-- report the problem -- not as definitions of the category.
UPDATE categories SET examples = $ex$the transformer burnt and there is no power
transformer exploded on the pole near our house
power lines are down and sparking
no electricity in the whole area since morning
blackout for three days
electric pole fell down
live wire hanging in the street
meter is not working$ex$
WHERE name = 'Electricity & Power Supply' AND (examples IS NULL OR examples = '');

UPDATE categories SET examples = $ex$there is a fire burning in the market
a house is on fire
fire has started in the building
we need the fire brigade urgently
bush fire spreading towards the houses$ex$
WHERE name = 'Fire Services' AND (examples IS NULL OR examples = '');

UPDATE categories SET examples = $ex$rubbish has not been collected for weeks
piles of refuse on the roadside
garbage dumped near the market
waste bins overflowing
people are dumping dirt in the open$ex$
WHERE name = 'Waste Management' AND (examples IS NULL OR examples = '');

UPDATE categories SET examples = $ex$the drain is blocked and water is not flowing
flooding whenever it rains
gutter is choked with rubbish
water enters our compound during heavy rain
culvert is blocked$ex$
WHERE name = 'Drainage & Flooding' AND (examples IS NULL OR examples = '');

UPDATE categories SET examples = $ex$the street light is not working
no lights on our road at night
street lamp has been off for months
the whole street is dark at night$ex$
WHERE name = 'Streetlights' AND (examples IS NULL OR examples = '');

UPDATE categories SET examples = $ex$there is a big pothole in the road
the road has broken up badly
cracks and holes making the road impassable
the tarmac has washed away$ex$
WHERE name = 'Road Infrastructure' AND (examples IS NULL OR examples = '');

UPDATE categories SET examples = $ex$drivers are not respecting the traffic lights
vehicles speeding through the junction
dangerous driving near the school
no road markings at the crossing
accident black spot with no signs$ex$
WHERE name = 'Road Safety' AND (examples IS NULL OR examples = '');

UPDATE categories SET examples = $ex$the toilet is overflowing
sewage is running in the street
septic tank has burst
bad smell from the drain behind the houses$ex$
WHERE name = 'Sewage & Sanitation' AND (examples IS NULL OR examples = '');

UPDATE categories SET examples = $ex$there is no water in the taps
the pipe has burst and water is wasting
our community has had no water supply for days
the well has dried up$ex$
WHERE name = 'Water Supply' AND (examples IS NULL OR examples = '');

UPDATE categories SET examples = $ex$traffic is always blocked at this junction
vehicles parked badly causing congestion
the traffic light is not working
no traffic warden at the busy crossing$ex$
WHERE name = 'Traffic Management' AND (examples IS NULL OR examples = '');

UPDATE categories SET examples = $ex$poda poda drivers are overcharging
no buses on this route
the lorry park is disorganised
taxi drivers refusing to carry passengers$ex$
WHERE name = 'Public Transportation' AND (examples IS NULL OR examples = '');

UPDATE categories SET examples = $ex$traders have taken over the walkway
the market is disorganised and dirty
stalls are blocking the road
market shed has collapsed$ex$
WHERE name = 'Market Operations' AND (examples IS NULL OR examples = '');
