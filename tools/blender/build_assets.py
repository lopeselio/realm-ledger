"""Builds every Realm Ledger miniature from scratch and exports .glb files.

Run headless from the repo root:
  /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/blender/build_assets.py

Outputs:
  apps/web/public/models/<name>.glb     the game assets
  tools/blender/previews/<name>.png     a render of each, for review

Everything is modelled here in code: no imported meshes, no asset packs. Each realm-coloured
part uses a material named "Enamel"; the game recolours it per realm at runtime, like paint
on a miniature. Units: 1 = one hex radius on the war table.
"""

import math
import os

import bpy
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "apps", "web", "public", "models")
PREVIEWS = os.path.join(ROOT, "tools", "blender", "previews")
os.makedirs(OUT, exist_ok=True)
os.makedirs(PREVIEWS, exist_ok=True)


# ---------- helpers ----------

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def material(name, color, metallic=0.0, roughness=0.5):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    return m


def mats():
    return {
        "pewter": material("Pewter", (0.42, 0.43, 0.45), metallic=0.85, roughness=0.38),
        "enamel": material("Enamel", (0.7, 0.16, 0.14), metallic=0.0, roughness=0.28),
        "stone": material("Stone", (0.4, 0.37, 0.33), roughness=0.85),
        "roof": material("Roof", (0.45, 0.2, 0.14), roughness=0.7),
        "wood": material("Wood", (0.36, 0.24, 0.14), roughness=0.75),
        "leaf": material("Leaf", (0.08, 0.2, 0.09), roughness=0.8),
        "plaster": material("Plaster", (0.72, 0.66, 0.55), roughness=0.85),
    }


def add(obj, mat, smooth=True, bevel=0.0):
    obj.data.materials.append(mat)
    if smooth:
        for p in obj.data.polygons:
            p.use_smooth = True
    if bevel > 0:
        b = obj.modifiers.new("bevel", "BEVEL")
        b.width = bevel
        b.segments = 2
        b.limit_method = "ANGLE"
    return obj


def cyl(r, depth, loc, mat, verts=24, r2=None, bevel=0.0):
    if r2 is None:
        bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=depth, location=loc)
    else:
        bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=r2, depth=depth, location=loc)
    return add(bpy.context.object, mat, bevel=bevel)


def box(size, loc, mat, bevel=0.0, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.object
    o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    return add(o, mat, smooth=False, bevel=bevel)


def sphere(r, loc, mat, segs=16):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segs, ring_count=segs // 2, radius=r, location=loc)
    return add(bpy.context.object, mat)


def cone(r, depth, loc, mat, verts=16, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, depth=depth, location=loc, rotation=rot)
    return add(bpy.context.object, mat)


def base(m, r=0.16):
    """The enamelled round base every miniature stands on."""
    cyl(r, 0.035, (0, 0, 0.0175), m["enamel"], verts=32, bevel=0.006)
    cyl(r * 0.94, 0.008, (0, 0, 0.039), m["pewter"], verts=32)


def join_all(name):
    bpy.ops.object.select_all(action="SELECT")
    objs = [o for o in bpy.context.selected_objects if o.type == "MESH"]
    bpy.context.view_layer.objects.active = objs[0]
    for o in objs:
        bpy.context.view_layer.objects.active = o
        for mod in list(o.modifiers):
            bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    obj = bpy.context.object
    obj.name = name
    return obj


def export(name):
    path = os.path.join(OUT, f"{name}.glb")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=False,
        export_apply=True,
        export_draco_mesh_compression_enable=False,
        export_draco_mesh_compression_level=6,
    )
    return path


def preview(name, distance=1.1, height=0.45):
    """Renders the model on a dark table under a warm key light, for review."""
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = 640
    scene.render.resolution_y = 640
    scene.render.film_transparent = False
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.03, 0.025, 0.02, 1)
    scene.world = world
    bpy.ops.mesh.primitive_plane_add(size=4, location=(0, 0, 0))
    bpy.context.object.data.materials.append(material("Table", (0.22, 0.14, 0.08), roughness=0.6))
    bpy.ops.object.light_add(type="AREA", location=(0.8, -0.9, 1.4))
    key = bpy.context.object
    key.data.energy = 120
    key.data.color = (1.0, 0.82, 0.6)
    key.data.size = 0.6
    key.rotation_euler = (math.radians(45), 0, math.radians(40))
    bpy.ops.object.light_add(type="POINT", location=(-0.9, 0.7, 0.8))
    bpy.context.object.data.energy = 25
    bpy.context.object.data.color = (0.6, 0.7, 1.0)
    target = Vector((0, 0, height * 0.55))
    bpy.ops.object.camera_add(location=(distance * 0.75, -distance, height + distance * 0.55))
    cam = bpy.context.object
    direction = target - cam.location
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    cam.data.lens = 50
    scene.camera = cam
    scene.render.filepath = os.path.join(PREVIEWS, f"{name}.png")
    bpy.ops.render.render(write_still=True)


def build(name, make, **pv):
    reset()
    m = mats()
    make(m)
    join_all(name)
    export(name)
    preview(name, **pv)
    print(f"built {name}")


# ---------- the miniatures ----------

def soldier(m):
    base(m)
    # legs and tunic
    cyl(0.055, 0.12, (0, 0, 0.1), m["pewter"], verts=16, r2=0.045)
    cyl(0.06, 0.13, (0, 0, 0.2), m["pewter"], verts=16, r2=0.045)
    # a sash and a belt in realm colours, wrapped around the body
    cyl(0.058, 0.035, (0, 0, 0.215), m["enamel"], verts=16)
    cyl(0.053, 0.018, (0, 0, 0.16), m["enamel"], verts=16)
    # head and helmet
    sphere(0.038, (0, 0, 0.3), m["pewter"])
    cone(0.045, 0.06, (0, 0, 0.345), m["pewter"])
    # shield on the left arm, with an enamel boss
    cyl(0.06, 0.012, (-0.075, -0.02, 0.2), m["pewter"], verts=20).rotation_euler = (math.radians(90), 0, math.radians(70))
    sphere(0.016, (-0.083, -0.025, 0.2), m["enamel"], segs=10)
    # spear in the right hand
    cyl(0.006, 0.42, (0.07, 0.0, 0.25), m["wood"], verts=8)
    cone(0.014, 0.05, (0.07, 0.0, 0.485), m["pewter"], verts=8)


def keep(m):
    base(m, r=0.3)
    stone = m["stone"]
    box((0.26, 0.26, 0.3), (0, 0, 0.19), stone, bevel=0.006)
    # crenellations
    for i in range(4):
        for j in (-1, 1):
            box((0.05, 0.05, 0.05), (-0.105 + i * 0.07, j * 0.105, 0.365), stone)
            box((0.05, 0.05, 0.05), (j * 0.105, -0.105 + i * 0.07, 0.365), stone)
    # corner tower with a roof
    cyl(0.07, 0.42, (0.12, 0.12, 0.25), stone, verts=20, bevel=0.004)
    cone(0.085, 0.14, (0.12, 0.12, 0.53), m["roof"], verts=20)
    # door
    box((0.06, 0.01, 0.09), (0, -0.131, 0.09), m["wood"])
    # banner pole with a realm-coloured flag
    cyl(0.006, 0.3, (-0.09, -0.09, 0.5), m["wood"], verts=8)
    box((0.11, 0.006, 0.07), (-0.035, -0.09, 0.6), m["enamel"])


def town(m):
    base(m, r=0.3)
    for (x, y, rot, s) in [(-0.1, -0.05, 15, 1.35), (0.12, 0.02, -20, 1.15), (0.0, 0.15, 40, 1.0)]:
        r = math.radians(rot)
        box((0.12 * s, 0.1 * s, 0.09 * s), (x, y, 0.04 + 0.045 * s), m["plaster"], bevel=0.003, rot=(0, 0, r))
        bpy.ops.mesh.primitive_cone_add(vertices=4, radius1=0.1 * s, depth=0.08 * s, location=(x, y, 0.04 + 0.09 * s + 0.04 * s), rotation=(0, 0, r + math.radians(45)))
        add(bpy.context.object, m["roof"], smooth=False)
    # a market banner in realm colours
    cyl(0.005, 0.22, (0.17, -0.19, 0.15), m["wood"], verts=8)
    box((0.07, 0.005, 0.045), (0.205, -0.19, 0.235), m["enamel"])


def fort(m):
    # a ring of stone wall segments with towers, sized to sit around a hex
    stone = m["stone"]
    n = 6
    for i in range(n):
        a = i / n * math.tau
        x, y = math.cos(a) * 0.62, math.sin(a) * 0.62
        cyl(0.07, 0.2, (x, y, 0.1), stone, verts=14, bevel=0.003)
        a2 = (i + 0.5) / n * math.tau
        box((0.5, 0.05, 0.12), (math.cos(a2) * 0.56, math.sin(a2) * 0.56, 0.06), stone, rot=(0, 0, a2 + math.pi / 2))


def tree(m):
    cyl(0.025, 0.1, (0, 0, 0.05), m["wood"], verts=8)
    for i, (r, z) in enumerate([(0.14, 0.15), (0.11, 0.25), (0.075, 0.34)]):
        cone(r, 0.16, (0, 0, z), m["leaf"], verts=10)


if __name__ == "__main__":
    build("soldier", soldier, distance=0.85, height=0.35)
    build("keep", keep, distance=1.3, height=0.55)
    build("town", town, distance=1.1, height=0.3)
    build("fort", fort, distance=2.0, height=0.3)
    build("tree", tree, distance=0.8, height=0.35)
    print("all assets built")
