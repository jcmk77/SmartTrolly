# SmartTrolly

SmartTrolly is an intelligent indoor transport trolley designed to move
equipment and supplies safely and efficiently. It is intended for environments
such as event spaces, campuses, offices, and commercial facilities where
repetitive transport tasks can be assisted or automated.

This is a school project, involving a team of four people.

The project combines the physical trolley, robot software, map-preparation
tools, and operating documentation in one repository. Operators can select a
destination on a map, supervise the trolley during a mission, stop it when
needed, or use manual control for positioning and recovery.

## Project Highlights

- Indoor, map-based transport and destination selection
- Obstacle-aware operation with local safety monitoring
- Manual control for setup, positioning, and recovery
- Purpose-built mapping application for preparing robot maps
- Operational guidance covering setup, safety, maintenance, and troubleshooting

## Physical Design

The prototype uses a low-profile rectangular trolley layout that provides a
stable platform for carrying equipment while remaining easy to load and
unload.

| Item | Description |
| --- | --- |
| Overall size | Approximately 1.0 m long, 0.6 m wide, and 0.3 m high |
| Payload capacity | Up to 50 kg |
| Frame | Aluminum structural frame |
| Payload platform | High-density polyethylene (HDPE) top deck |
| Load retention | Attachment points for securing cargo with straps |
| Drive layout | Two-wheel differential drive with two supporting caster wheels |
| Drive wheels | Approximately 152 mm diameter with 440 mm center spacing |
| Perception | Front-mounted 2D LiDAR for navigation and obstacle awareness |
| Power | Onboard 22.2 V, 6-cell battery system |
| Electronics | Integrated enclosure for motor control, computing, and power components |

Dimensions and ratings describe the current prototype and should be confirmed
against the physical build before fabrication, maintenance, or operation.

## Repository Contents

- `Trolly/` contains the robot software, configuration, simulation, and
  embedded motor-control firmware.
- `MapApp/` provides tools for preparing maps for the robot.
- `OperationalManual.pdf` explains installation, daily operation, safety,
  maintenance, and troubleshooting.

## Intended Use

SmartTrolly is designed as an indoor material-handling platform for moving
items such as event equipment, supplies, and other secured loads between known
destinations. It is a prototype project and should be operated under human
supervision. Read the operational manual and complete the required safety
checks before use.
