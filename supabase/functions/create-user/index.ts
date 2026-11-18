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

// Mismo normalizador que admin/context/AppContext.tsx (normalizeSlug)
const normalizeSlug = (str: string): string =>
    str
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .trim() || "taller";

const randomSuffix = () => Math.random().toString(36).slice(2, 7);

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
            return json({ error: "No tienes permisos para crear usuarios." }, 403);
        }

        const { data: mfaVerified, error: mfaError } = await supabaseClient.rpc('security_has_aal2');
        if (mfaError || mfaVerified !== true) return json({ error: 'Verifica tu segundo factor para continuar.', code: 'MFA_REQUIRED' }, 403);

        const body = await req.json();
        const { email, password, nombre, role, telefono } = body;

        if (!email || !password || !nombre) {
            return json({ error: "Faltan campos obligatorios: email, password, nombre" });
        }
        if (password.length < 12) {
            return json({ error: "La contrasena debe tener al menos 12 caracteres" });
        }


        // El caller ya es super_admin, asi que aceptar 'super_admin' en el body no es
        // escalada de privilegios; cualquier otro valor cae a tallerista (comportamiento vivo).
        const dbRole = (role === "Super Admin" || role === "super_admin") ? "super_admin" : "tallerista";

        const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
            user_metadata: { full_name: nombre, role: dbRole },
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
            {
                id: newUser.user.id,
                email,
                full_name: nombre,
                phone: telefono || null,
                role: dbRole,
            },
            { onConflict: "id" }
        );

        if (profileWriteError) { await supabaseAdmin.auth.admin.deleteUser(newUser.user.id); return json({error:'No se pudo crear el perfil.'},500); }

        // Auto-creación de la sede: el paso 2 del formulario (WorkshopForm) la rellena después.
        if (dbRole !== "tallerista") {
            return json({ id: newUser.user.id, email, sede: null });
        }

        const baseSlug = normalizeSlug(nombre);
        const sedePayload = (slug: string) => ({
            name: `Taller de ${nombre}`,
            address: "Direccion pendiente",
            slug,
            owner_id: newUser.user.id,
            is_active: true,
        });

        const { data: sede, error: sedeError } = await supabaseAdmin
            .from("sedes")
            .insert(sedePayload(baseSlug))
            .select("id, name")
            .single();

        if (sedeError && sedeError.code === "23505") {
            const { data: retried, error: retryError } = await supabaseAdmin
                .from("sedes")
                .insert(sedePayload(`${baseSlug}-${randomSuffix()}`))
                .select("id, name")
                .single();
            if (retryError) {
                return json({ id: newUser.user.id, email, sede: { error: retryError.message } });
            }
            return json({ id: newUser.user.id, email, sede: { id: retried?.id, name: retried?.name } });
        }

        if (sedeError) {
            // No fatal: WorkshopForm hará fallback a addWorkshop si no encuentra sede.
            console.error("create-user: sede insert error", sedeError.message);
            return json({ id: newUser.user.id, email, sede: { error: sedeError.message } });
        }

        return json({ id: newUser.user.id, email, sede: { id: sede?.id, name: sede?.name } });
    } catch (error: any) {
        console.error("Function Error:", error);
        return json({ error: error.message || "Internal Server Error" });
    }
});
