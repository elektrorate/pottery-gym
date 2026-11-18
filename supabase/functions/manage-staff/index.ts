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

        if (!callerProfile) {
            return json({ error: "Perfil no encontrado." }, 403);
        }

        const isSuperAdmin = callerProfile.role === 'super_admin';
        const isTallerista = callerProfile.role === 'tallerista';

        if (!isSuperAdmin && !isTallerista) {
            return json({ error: "No tienes permisos para gestionar el equipo." }, 403);
        }

        const { data: mfaVerified, error: mfaError } = await supabaseClient.rpc('security_has_aal2');
        if (mfaError || mfaVerified !== true) return json({ error: 'Verifica tu segundo factor para continuar.', code: 'MFA_REQUIRED' }, 403);

        const body = await req.json();
        const { action } = body;

        let callerSede: any = null;
        if (isTallerista) {
            const { data: sede } = await supabaseAdmin
                .from("sedes")
                .select("id, name")
                .eq("owner_id", user.id)
                .single();
            callerSede = sede;
            if (!callerSede) {
                return json({ error: "No se encontro tu estudio/sede." });
            }
        }

        // ACTION: CREATE
        if (action === "create") {
            if (!isTallerista) {
                return json({ error: "Solo los talleristas pueden crear staff." });
            }

            const { email, password, nombre } = body;

            if (!email || !password || !nombre) {
                return json({ error: "Faltan campos obligatorios: email, password, nombre" });
            }
            if (password.length < 12) {
                return json({ error: "La contrasena debe tener al menos 12 caracteres" });
            }

            const { count } = await supabaseAdmin
                .from("sede_members")
                .select("id", { count: "exact", head: true })
                .eq("sede_id", callerSede.id);

            if ((count ?? 0) >= 10) {
                return json({ error: "Has alcanzado el limite maximo de administradores (10)." });
            }

            const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
                email,
                password,
                email_confirm: true,
                user_metadata: { full_name: nombre, role: "staff" }
            });

            if (createError) {
                let errorMessage = createError.message || "Error al crear el usuario";
                if (/already (been )?registered|duplicate|email address/i.test(errorMessage)) {
                    errorMessage = "El correo electronico ya esta registrado.";
                }
                return json({ error: errorMessage });
            }

            if (!newUser?.user?.id) {
                return json({ error: "Error inesperado: usuario creado sin ID." });
            }

            // Garantiza el perfil exista aunque el trigger on_auth_user_created no exista.
            const {error: profileWriteError} = await supabaseAdmin.from("profiles").upsert(
                { id: newUser.user.id, email, role: "staff", full_name: nombre },
                { onConflict: "id" }
            );

            if (profileWriteError) { await supabaseAdmin.auth.admin.deleteUser(newUser.user.id); return json({error:'No se pudo crear el perfil.'},500); }
            const { error: memberError } = await supabaseAdmin
                .from("sede_members")
                .insert({ sede_id: callerSede.id, user_id: newUser.user.id, role: "staff" });

            if (memberError) {
                await supabaseAdmin.auth.admin.deleteUser(newUser.user.id);
                return json({ error: "Error al vincular administrador al estudio." });
            }

            return json({ success: true, message: "Administrador creado exitosamente.", staff: { id: newUser.user.id, email, name: nombre } });
        }

        // ACTION: LIST
        if (action === "list") {
            if (isTallerista) {
                // Only fetch staff members, exclude the tallerista (owner) themselves
                const { data: members } = await supabaseAdmin
                    .from("sede_members")
                    .select(`id, user_id, role, joined_at, profiles:user_id ( id, email, full_name, role, created_at )`)
                    .eq("sede_id", callerSede.id)
                    .eq("role", "staff");

                const staffList = (members || []).map((m: any) => ({ id: m.user_id, memberId: m.id, email: m.profiles?.email || "", name: m.profiles?.full_name || "", role: m.role, joinedAt: m.joined_at }));
                return json({ success: true, staff: staffList });
            }

            if (isSuperAdmin) {
                const { data: profiles } = await supabaseAdmin
                    .from("profiles")
                    .select("id, email, full_name, phone, role, created_at")
                    .in("role", ["tallerista", "staff"])
                    .order("full_name");

                return json({ success: true, staff: profiles || [] });
            }
        }

        // ACTION: DELETE - CORREGIDO para permitir super_admin
        if (action === "delete") {
            const { staffUserId } = body;
            if (!staffUserId) return json({ error: "Falta el ID del usuario a eliminar." });
            if (staffUserId === user.id) return json({ error: "No puedes eliminarte a ti mismo." });

            const { data: targetProfile } = await supabaseAdmin
                .from("profiles")
                .select("role, full_name")
                .eq("id", staffUserId)
                .single();

            if (!targetProfile) {
                return json({ error: "Usuario no encontrado." });
            }

            if (isTallerista && targetProfile.role !== 'staff') return json({error:'Solo puedes gestionar cuentas de staff.'},403);

            // SUPER ADMIN puede eliminar talleristas y staff
            if (isSuperAdmin) {
                if (!['tallerista', 'staff'].includes(targetProfile.role)) {
                    return json({ error: "Solo puedes eliminar talleristas y staff." });
                }
                await supabaseAdmin.from("sede_members").delete().eq("user_id", staffUserId);
                await supabaseAdmin.from("profiles").delete().eq("id", staffUserId);
                const { error: authDelError } = await supabaseAdmin.auth.admin.deleteUser(staffUserId);
                if (authDelError) {
                    return json({ error: `Error al eliminar: ${authDelError.message}` });
                }
                                return json({ success: true, message: "Usuario eliminado correctamente." });
            }

            // Remove only this workshop membership, preserving other workshops and Auth.
            if (isTallerista) {
                const { data: membership, error: memberError } = await supabaseAdmin.from('sede_members').select('id').eq('sede_id',callerSede.id).eq('user_id',staffUserId).eq('role','staff').single();
                if (memberError || !membership) return json({error:'Este usuario no es staff de tu taller.'},403);
                const {error: unlinkError} = await supabaseAdmin.from('sede_members').delete().eq('id',membership.id).eq('sede_id',callerSede.id);
                if (unlinkError) return json({error:'No se pudo retirar el acceso.'},500);
                return json({success:true,message:'Acceso al taller retirado correctamente.'});
            }

            return json({ error: "No tienes permisos para eliminar usuarios." }, 403);
        }

        // ACTION: UPDATE_PROFILE
        if (action === "update_profile") {
            const { targetUserId, full_name, phone } = body;
            const updateId = targetUserId || user.id;

            if (updateId !== user.id) {
                if (isSuperAdmin) {
                    const { data: tp } = await supabaseAdmin.from("profiles").select("role").eq("id", updateId).single();
                    if (!tp || !['tallerista', 'staff'].includes(tp.role)) {
                        return json({ error: "Solo puedes editar talleristas y staff." });
                    }
                } else if (isTallerista) {
                    const {data: target, error: targetError} = await supabaseAdmin.from('profiles').select('role').eq('id',updateId).single();
                    if (targetError || target?.role !== 'staff') return json({error:'Solo puedes gestionar cuentas de staff.'},403);
                    const {data: otherLinks, error: linksError} = await supabaseAdmin.from('sede_members').select('sede_id').eq('user_id',updateId);
                    if (linksError || otherLinks?.some((link:any)=>link.sede_id !== callerSede.id)) return json({error:'La cuenta tiene acceso a otro taller. Requiere un superadministrador.'},403);
                    const { data: membership } = await supabaseAdmin.from("sede_members").select("id").eq("sede_id", callerSede.id).eq("user_id", updateId).single();
                    if (!membership) return json({ error: "No tienes permisos para editar este usuario." }, 403);
                }
            }

            const updatePayload: Record<string, any> = {};
            if (full_name !== undefined) updatePayload.full_name = full_name;
            if (phone !== undefined) updatePayload.phone = phone;

            if (Object.keys(updatePayload).length === 0) {
                return json({ error: "No hay campos para actualizar." });
            }

            await supabaseAdmin.from("profiles").update(updatePayload).eq("id", updateId);
            await supabaseAdmin.auth.admin.updateUserById(updateId, { user_metadata: updatePayload });

            return json({ success: true, message: "Perfil actualizado correctamente." });
        }

        // ACTION: UPDATE_PASSWORD
        if (action === "update_password") {
            const { staffUserId, password } = body;

            if (!staffUserId || !password) return json({ error: "Faltan campos requeridos." });
            if (password.length < 12) return json({ error: "La contrasena debe tener al menos 12 caracteres." });

            const { data: tp } = await supabaseAdmin.from("profiles").select("role").eq("id", staffUserId).single();
            if (!tp) return json({ error: "Usuario no encontrado." });

            if (isTallerista) {
                if (tp.role !== 'staff') return json({error:'Solo puedes gestionar cuentas de staff.'},403);
                const {data: otherLinks, error: linksError} = await supabaseAdmin.from('sede_members').select('sede_id').eq('user_id',staffUserId);
                if (linksError || otherLinks?.some((link:any)=>link.sede_id !== callerSede.id)) return json({error:'La cuenta tiene acceso a otro taller. Requiere un superadministrador.'},403);
                const { data: membership } = await supabaseAdmin.from("sede_members").select("id").eq("sede_id", callerSede.id).eq("user_id", staffUserId).single();
                if (!membership) return json({ error: "No tienes permisos para cambiar la contrasena de este usuario." }, 403);
            } else if (isSuperAdmin) {
                if (!['tallerista', 'staff'].includes(tp.role)) {
                    return json({ error: "Solo puedes cambiar contrasenas de talleristas y staff." });
                }
            }

            const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(staffUserId, { password });
            if (updateError) {
                return json({ error: `Error al actualizar contrasena: ${updateError.message}` });
            }

            return json({ success: true, message: "Contrasena actualizada correctamente." });
        }

        return json({ error: `Accion desconocida: ${action}` });

    } catch (error: any) {
        console.error("Function Error:", error);
        return json({ error: error.message || "Internal Server Error" });
    }
});
