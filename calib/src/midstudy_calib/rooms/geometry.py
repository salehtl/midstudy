"""Rotations and the §4.9 pose (contract §4.1, §4.9 Frames).

A member's pose {x_m, z_m, yaw_deg} and scale map its scene frame into the room frame:

    p_room = Ry(yaw) · (scale · p_scene) + (x_m, 0, z_m)
    Ry(a)  = [[cos a, 0, sin a], [0, 1, 0], [−sin a, 0, cos a]]      positive yaw: counterclockwise seen from above

`scale` multiplies the member's camera height (its effective camera); the scene frame is scaled about the floor point
under the camera, so (x_m, z_m) is where that camera stands on the room's floor.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Final

import numpy as np
from numpy.typing import NDArray

type F64 = NDArray[np.float64]

# contract §4.9 Ranges (every writer clamps)
POS_LIMIT_M: Final = 50.0
SCALE_RANGE: Final = (0.25, 4.0)


def rx(a: float) -> F64:
    c, s = math.cos(a), math.sin(a)
    return np.array([[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]], dtype=np.float64)


def ry(a: float) -> F64:
    """Contract §4.9: positive is counterclockwise seen from above (+X turns toward −Z)."""
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]], dtype=np.float64)


def rz(a: float) -> F64:
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]], dtype=np.float64)


def yaw_of(m: F64) -> float:
    """The turn about Y (radians) of the pure Ry rotation nearest to m."""
    return math.atan2(float(m[0, 2] - m[2, 0]), float(m[0, 0] + m[2, 2]))


def wrap_deg(a: float) -> float:
    """Contract §4.9: into (−180, 180]: ((a + 180) mod 360) − 180, then −180 becomes 180."""
    y = (a + 180.0) % 360.0 - 180.0
    return 180.0 if y <= -180.0 else y


def rotation_to_up(u: F64) -> F64:
    """The smallest rotation taking the unit vector u to +Y (Rodrigues)."""
    y = np.array([0.0, 1.0, 0.0])
    v = np.cross(u, y)
    s, c = float(np.linalg.norm(v)), float(np.dot(u, y))
    if s < 1e-12:
        return np.eye(3) if c > 0 else rx(math.pi)
    k = v / s
    kx = np.array([[0.0, -k[2], k[1]], [k[2], 0.0, -k[0]], [-k[1], k[0], 0.0]])
    return np.eye(3) + s * kx + (1 - c) * (kx @ kx)


@dataclass(frozen=True)
class Placement:
    """A member's pose in the room frame of the answer (yaw in radians) and its scale relative to the frame member."""

    x: float
    z: float
    yaw: float
    scale: float

    def scene_to_room(self, p: F64) -> F64:
        """(n, 3) scene-frame points -> room frame."""
        return (self.scale * p) @ ry(self.yaw).T + np.array([self.x, 0.0, self.z])

    def room_to_scene(self, p: F64) -> F64:
        """(n, 3) room-frame points -> this member's (effective) scene frame."""
        return ((p - np.array([self.x, 0.0, self.z])) @ ry(self.yaw)) / self.scale


FRAME: Final = Placement(0.0, 0.0, 0.0, 1.0)


def relative_to(p: Placement, a: Placement) -> Placement:
    """p re-expressed in the frame of member a (contract §4.9 Mock): yaw' = yaw − yaw_a,
    (x', z') = Ry(−yaw_a) · ((x, z) − (x_a, z_a)) / s_a, s' = s / s_a. relative_to(a, a) is the frame."""
    dx, dz = p.x - a.x, p.z - a.z
    c, s = math.cos(a.yaw), math.sin(a.yaw)
    # Ry(−a) on (x, 0, z): (cos a · x − sin a · z, 0, sin a · x + cos a · z)
    return Placement((c * dx - s * dz) / a.scale, (s * dx + c * dz) / a.scale, p.yaw - a.yaw, p.scale / a.scale)


def clamp_pos(v: float) -> float:
    return min(POS_LIMIT_M, max(-POS_LIMIT_M, v))


def clamp_scale(v: float) -> float:
    return min(SCALE_RANGE[1], max(SCALE_RANGE[0], v))
