import { serve } from "std/http/server.ts";
import { createClient } from "@supabase/supabase-js";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    try {
        const authHeader = req.headers.get("Authorization");
        if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

        const supabaseClient = createClient(
            Deno.env.get("SUPABASE_URL") ?? "",
            Deno.env.get("SUPABASE_ANON_KEY") ?? "",
            { global: { headers: { Authorization: authHeader } } }
        );
        const supabaseAdmin = createClient(
            Deno.env.get("SUPABASE_URL") ?? "",
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
        );

        const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
        if (userError || !user) return json({ error: "Unauthorized" }, 401);

        const { data: callerProfile } = await supabaseAdmin
            .from("profiles")
            .select("role, full_name")
            .eq("id", user.id)
            .single();

        if (!callerProfile) return json({ error: "Perfil no encontrado." }, 403);
        if (callerProfile.role !== "super_admin") {
            return json({ error: "No tienes permisos para eliminar usuarios." }, 403);
        }

        const { data: mfaVerified, error: mfaError } = await supabaseClient.rpc('security_has_aal2');
        if (mfaError || mfaVerified !== true) return json({ error: 'Verifica tu segundo factor para continuar.', code: 'MFA_REQUIRED' }, 403);

        const body = await req.json();
        const { userId } = body;

        if (!userId) return json({ error: "Falta el ID del usuario a eliminar." });
        if (userId === user.id) return json({ error: "No puedes eliminarte a ti mismo." });

        const { data: targetProfile } = await supabaseAdmin
            .from("profiles")
            .select("role, full_name")
            .eq("id", userId)
            .single();

        if (!targetProfile) return json({ error: "Usuario no encontrado." });
        if (!["tallerista", "staff"].includes(targetProfile.role)) {
            return json({ error: "Solo puedes eliminar talleristas y staff." });
        }


        const errors: string[] = [];
        const tryDelete = async (label: string, query: PromiseLike<{ error: any }>) => {
            const { error } = await query;
            if (error) errors.push(`${label}: ${error.message}`);
        };

        // 1) Membresías del usuario en cualquier sede (incluye staff ajeno)
        await tryDelete("sede_members(user)", supabaseAdmin
            .from("sede_members")
            .delete()
            .eq("user_id", userId));

        // 2) Sedes de las que es propietario + todos sus datos (hijo -> padre)
        const { data: ownedSedes } = await supabaseAdmin
            .from("sedes")
            .select("id")
            .eq("owner_id", userId);
        const sedeIds = (ownedSedes || []).map((s: any) => s.id);

        if (sedeIds.length) {
            const { data: students } = await supabaseAdmin
                .from("students")
                .select("id")
                .in("sede_id", sedeIds);
            const studentIds = (students || []).map((s: any) => s.id);

            await tryDelete("payments", supabaseAdmin.from("payments").delete().in("sede_id", sedeIds));
            if (studentIds.length) {
                await tryDelete("packages", supabaseAdmin.from("packages").delete().in("student_id", studentIds));
            }
            await tryDelete("session_students", supabaseAdmin.from("session_students").delete().in("sede_id", sedeIds));
            await tryDelete("gift_cards", supabaseAdmin.from("gift_cards").delete().in("sede_id", sedeIds));
            await tryDelete("pieces", supabaseAdmin.from("pieces").delete().in("sede_id", sedeIds));
            await tryDelete("inventory_movements", supabaseAdmin.from("inventory_movements").delete().in("sede_id", sedeIds));
            await tryDelete("inventory_items", supabaseAdmin.from("inventory_items").delete().in("sede_id", sedeIds));
            await tryDelete("students", supabaseAdmin.from("students").delete().in("sede_id", sedeIds));
            await tryDelete("sessions", supabaseAdmin.from("sessions").delete().in("sede_id", sedeIds));
            await tryDelete("teachers", supabaseAdmin.from("teachers").delete().in("sede_id", sedeIds));
            await tryDelete("sede_members(sede)", supabaseAdmin.from("sede_members").delete().in("sede_id", sedeIds));

            const { error: sedeError } = await supabaseAdmin
                .from("sedes")
                .delete()
                .in("id", sedeIds);

            if (sedeError) {
                // La sede no se pudo borrar: no borramos perfil/auth para poder reintentar.
                return json({
                    error: `No se pudo eliminar el taller: ${sedeError.message}`,
                    partialErrors: errors,
                });
            }
        }

        if (errors.length) {
            return json({
                error: `El taller se elimino pero quedaron datos sin borrar: ${errors.join(" | ")}`,
                partialErrors: errors,
            });
        }

        // 3) Perfil y usuario de auth
        const { error: profileError } = await supabaseAdmin
            .from("profiles")
            .delete()
            .eq("id", userId);
        if (profileError) {
            return json({ error: `No se pudo eliminar el perfil: ${profileError.message}` });
        }

        const { error: authDelError } = await supabaseAdmin.auth.admin.deleteUser(userId);
        if (authDelError) {
            return json({ error: `Error al eliminar: ${authDelError.message}` });
        }

        console.log(`[SuperAdmin] User deleted: ${userId} by ${callerProfile.full_name}`);
        return json({ success: true, message: "Usuario y taller eliminados correctamente." });
    } catch (error: any) {
        console.error("Function Error:", error);
        return json({ error: error.message || "Internal Server Error" });
    }
});
