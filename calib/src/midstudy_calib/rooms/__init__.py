"""`midstudy-calib align-room` (contract §4.3, §4.9 Align): where each photo of a room was taken.

    command.py    the command: reads the scene folders, runs the mock or a solver, scores, validates, writes align.json
    photos.py     one scene folder as the solvers see it (photo, calib camera, depth.png) and §4.1's projection
    geometry.py   rotations, the §4.9 pose (scene frame -> room frame), yaw wrapping, the mock's re-expression
    solver.py     the Solver protocol, a learned solver's cameras -> §4.9 poses (from_views), choosing a solver
    score.py      residuals, the constraint factor, confidence and the loop residual (every solver)
    mast3r.py     MASt3R (Gate A's choice; the optional `rooms` extra), the one untyped boundary of this package
    manhattan.py  the no-dependency fallback: walls snapped to two square directions, placed by 2D correlation + ICP
    mock.py       MIDSTUDY_CALIB_MOCK: the key of a set of photos and the recorded answer, renamed and re-expressed
"""
