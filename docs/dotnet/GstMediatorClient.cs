// Reference implementation for the existing .NET e-Procurement portal (.NET 6+).
// Mirrors src/mediatorClient.js + src/gstin.js + src/gstr1.js of the prototype.
// Endpoint paths follow the prototype's mock; align them with the chosen GSP/ASP (e.g. Quicko) API reference.
//
// Registration (Program.cs):
//   builder.Services.Configure<GstMediatorOptions>(builder.Configuration.GetSection("GstMediator"));
//   builder.Services.AddHttpClient<IGstMediator, GstMediatorClient>();

using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Options;

namespace EProcurement.Gst
{
    public sealed class GstMediatorOptions
    {
        public string BaseUrl { get; set; } = "";
        public string ApiKey { get; set; } = "";      // load from Key Vault, never from source control
        public string ApiSecret { get; set; } = "";
        public string SupplierGstin { get; set; } = "";
        public string GstUsername { get; set; } = "";
        public int ChunkSize { get; set; } = 5000;
    }

    public interface IGstMediator
    {
        Task<GstinDetails> SearchGstinAsync(string gstin, CancellationToken ct = default);
        Task RequestOtpAsync(CancellationToken ct = default);
        Task<string> CreateTaxpayerSessionAsync(string otp, CancellationToken ct = default);
        Task<string> SaveGstr1Async(string session, string period, Gstr1Payload part, CancellationToken ct = default);
        Task<SaveStatus> GetSaveStatusAsync(string session, string period, string referenceId, CancellationToken ct = default);
        Task<Gstr1Summary> GetSummaryAsync(string session, string period, CancellationToken ct = default);
        Task<string> FileGstr1Async(string session, string period, string evcOtp, string summaryHash, CancellationToken ct = default);
    }

    // ------------------------------------------------------------------ DTOs (GSTN field names)
    public sealed record GstinDetails(
        [property: JsonPropertyName("gstin")] string Gstin,
        [property: JsonPropertyName("lgnm")] string LegalName,
        [property: JsonPropertyName("tradeNam")] string? TradeName,
        [property: JsonPropertyName("sts")] string Status,
        [property: JsonPropertyName("ctb")] string? Constitution,
        [property: JsonPropertyName("rgdt")] string? RegisteredOn);

    public sealed class Gstr1Payload
    {
        [JsonPropertyName("gstin")] public string Gstin { get; set; } = "";
        [JsonPropertyName("fp")] public string Fp { get; set; } = "";
        [JsonPropertyName("b2b")] public List<B2bParty>? B2b { get; set; }
        [JsonPropertyName("b2cs")] public List<B2csRow>? B2cs { get; set; }
        [JsonPropertyName("hsn")] public JsonElement? Hsn { get; set; }
        [JsonPropertyName("doc_issue")] public JsonElement? DocIssue { get; set; }
    }
    public sealed record B2bParty([property: JsonPropertyName("ctin")] string Ctin, [property: JsonPropertyName("inv")] List<B2bInvoice> Inv);
    public sealed record B2bInvoice(
        [property: JsonPropertyName("inum")] string Inum,
        [property: JsonPropertyName("idt")] string Idt,          // dd-MM-yyyy
        [property: JsonPropertyName("val")] decimal Val,
        [property: JsonPropertyName("pos")] string Pos,
        [property: JsonPropertyName("rchrg")] string Rchrg,
        [property: JsonPropertyName("inv_typ")] string InvTyp,
        [property: JsonPropertyName("itms")] List<B2bItem> Itms);
    public sealed record B2bItem([property: JsonPropertyName("num")] int Num, [property: JsonPropertyName("itm_det")] ItemDetail ItmDet);
    public sealed record ItemDetail(
        [property: JsonPropertyName("txval")] decimal Txval, [property: JsonPropertyName("rt")] decimal Rt,
        [property: JsonPropertyName("iamt")] decimal Iamt, [property: JsonPropertyName("camt")] decimal Camt,
        [property: JsonPropertyName("samt")] decimal Samt, [property: JsonPropertyName("csamt")] decimal Csamt);
    public sealed record B2csRow(
        [property: JsonPropertyName("sply_ty")] string SplyTy, [property: JsonPropertyName("pos")] string Pos,
        [property: JsonPropertyName("typ")] string Typ, [property: JsonPropertyName("rt")] decimal Rt,
        [property: JsonPropertyName("txval")] decimal Txval, [property: JsonPropertyName("iamt")] decimal Iamt,
        [property: JsonPropertyName("camt")] decimal Camt, [property: JsonPropertyName("samt")] decimal Samt,
        [property: JsonPropertyName("csamt")] decimal Csamt);

    public sealed record SaveError([property: JsonPropertyName("inum")] string? Inum, [property: JsonPropertyName("ctin")] string? Ctin, [property: JsonPropertyName("error")] string Error);
    public sealed record SaveStatus(
        [property: JsonPropertyName("status_cd")] string StatusCode,  // IP, P, PE, ER
        [property: JsonPropertyName("error_count")] int? ErrorCount,
        [property: JsonPropertyName("error_report")] List<SaveError>? ErrorReport);
    public sealed record Gstr1Summary(
        [property: JsonPropertyName("summary")] JsonElement Summary,
        [property: JsonPropertyName("summary_hash")] string SummaryHash);

    // ------------------------------------------------------------------ client
    public sealed class GstMediatorClient : IGstMediator
    {
        private readonly HttpClient _http;
        private readonly GstMediatorOptions _opt;
        private string? _accessToken;
        private readonly SemaphoreSlim _authLock = new(1, 1);

        public GstMediatorClient(HttpClient http, IOptions<GstMediatorOptions> opt)
        {
            _opt = opt.Value;
            _http = http;
            _http.BaseAddress = new Uri(_opt.BaseUrl.TrimEnd('/') + "/");
            _http.Timeout = TimeSpan.FromSeconds(120);
        }

        private async Task EnsureAuthAsync(CancellationToken ct)
        {
            if (_accessToken != null) return;
            await _authLock.WaitAsync(ct);
            try
            {
                if (_accessToken != null) return;
                using var req = new HttpRequestMessage(HttpMethod.Post, "authenticate");
                req.Headers.Add("x-api-key", _opt.ApiKey);
                req.Headers.Add("x-api-secret", _opt.ApiSecret);
                using var res = await _http.SendAsync(req, ct);
                res.EnsureSuccessStatusCode();
                var body = await res.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: ct);
                _accessToken = body.GetProperty("access_token").GetString();
            }
            finally { _authLock.Release(); }
        }

        private async Task<JsonElement> SendAsync(HttpMethod method, string path, object? body, string? taxpayerToken, CancellationToken ct)
        {
            await EnsureAuthAsync(ct);
            using var req = new HttpRequestMessage(method, path.TrimStart('/'));
            req.Headers.Add("x-api-key", _opt.ApiKey);
            req.Headers.TryAddWithoutValidation("authorization", _accessToken);
            if (taxpayerToken != null) req.Headers.Add("x-taxpayer-token", taxpayerToken);
            if (body != null) req.Content = JsonContent.Create(body, body.GetType());
            using var res = await _http.SendAsync(req, ct);
            var json = await res.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: ct);
            // TODO: write method/path/status/duration/correlation id to GstApiLog
            if (!res.IsSuccessStatusCode)
            {
                if ((int)res.StatusCode == 401 && taxpayerToken == null) _accessToken = null; // force re-auth next call
                var message = json.ValueKind == JsonValueKind.Object && json.TryGetProperty("message", out var m) ? m.GetString() : res.ReasonPhrase;
                throw new GstMediatorException((int)res.StatusCode, message ?? "Mediator error");
            }
            return json;
        }

        private static T Data<T>(JsonElement json) => json.GetProperty("data").Deserialize<T>()!;

        public async Task<GstinDetails> SearchGstinAsync(string gstin, CancellationToken ct = default)
        {
            var v = Gstin.Validate(gstin);
            if (!v.Ok) throw new ArgumentException(v.Reason, nameof(gstin)); // offline check first: no API cost for typos
            return Data<GstinDetails>(await SendAsync(HttpMethod.Post, "gst/compliance/public/gstin/search", new { gstin = v.Value }, null, ct));
        }

        public Task RequestOtpAsync(CancellationToken ct = default) =>
            SendAsync(HttpMethod.Post, "gst/compliance/tax-payer/otp", new { gstin = _opt.SupplierGstin, username = _opt.GstUsername }, null, ct);

        public async Task<string> CreateTaxpayerSessionAsync(string otp, CancellationToken ct = default)
        {
            var json = await SendAsync(HttpMethod.Post, "gst/compliance/tax-payer/session", new { gstin = _opt.SupplierGstin, username = _opt.GstUsername, otp }, null, ct);
            return json.GetProperty("data").GetProperty("taxpayer_token").GetString()!;
        }

        public async Task<string> SaveGstr1Async(string session, string period, Gstr1Payload part, CancellationToken ct = default)
        {
            var json = await SendAsync(HttpMethod.Put, $"gst/compliance/tax-payer/gstrs/gstr-1/{period}", part, session, ct);
            return json.GetProperty("data").GetProperty("reference_id").GetString()!;
        }

        public async Task<SaveStatus> GetSaveStatusAsync(string session, string period, string referenceId, CancellationToken ct = default) =>
            Data<SaveStatus>(await SendAsync(HttpMethod.Get, $"gst/compliance/tax-payer/gstrs/gstr-1/{period}/status?reference_id={Uri.EscapeDataString(referenceId)}", null, session, ct));

        public async Task<Gstr1Summary> GetSummaryAsync(string session, string period, CancellationToken ct = default) =>
            Data<Gstr1Summary>(await SendAsync(HttpMethod.Get, $"gst/compliance/tax-payer/gstrs/gstr-1/{period}/summary", null, session, ct));

        public async Task<string> FileGstr1Async(string session, string period, string evcOtp, string summaryHash, CancellationToken ct = default)
        {
            var json = await SendAsync(HttpMethod.Post, $"gst/compliance/tax-payer/gstrs/gstr-1/{period}/file", new { otp = evcOtp, summary_hash = summaryHash }, session, ct);
            return json.GetProperty("data").GetProperty("arn").GetString()!;
        }
    }

    public sealed class GstMediatorException : Exception
    {
        public int StatusCode { get; }
        public GstMediatorException(int statusCode, string message) : base(message) => StatusCode = statusCode;
    }

    // ------------------------------------------------------------------ GSTIN offline validation (mod-36 check digit)
    public static class Gstin
    {
        private const string Charset = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        private static readonly System.Text.RegularExpressions.Regex Format =
            new("^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$", System.Text.RegularExpressions.RegexOptions.Compiled);

        public static char CheckChar(string first14)
        {
            int sum = 0;
            for (int i = 0; i < 14; i++)
            {
                int prod = Charset.IndexOf(first14[i]) * (i % 2 == 0 ? 1 : 2);
                sum += prod / 36 + prod % 36;
            }
            return Charset[(36 - sum % 36) % 36];
        }

        public static (bool Ok, string Value, string Reason) Validate(string? input)
        {
            var g = (input ?? "").Trim().ToUpperInvariant();
            if (!Format.IsMatch(g)) return (false, g, "Format invalid");
            if (CheckChar(g[..14]) != g[14]) return (false, g, "Check digit mismatch");
            return (true, g, "");
        }
    }

    // ------------------------------------------------------------------ batch filing workflow (run from Hangfire / Quartz)
    public sealed class Gstr1FilingService
    {
        private readonly IGstMediator _gst;
        public Gstr1FilingService(IGstMediator gst) => _gst = gst;

        /// <summary>Saves all parts sequentially, polling each reference id. Returns errors per invoice.</summary>
        public async Task<List<SaveError>> UploadAsync(string session, string period, IReadOnlyList<Gstr1Payload> parts,
            Func<int, string, Task> onPartSaved, CancellationToken ct = default)
        {
            var errors = new List<SaveError>();
            for (int i = 0; i < parts.Count; i++)
            {
                var refId = await _gst.SaveGstr1Async(session, period, parts[i], ct);
                SaveStatus st;
                var delay = TimeSpan.FromSeconds(2);
                do
                {
                    await Task.Delay(delay, ct);
                    st = await _gst.GetSaveStatusAsync(session, period, refId, ct);
                    delay = TimeSpan.FromSeconds(Math.Min(delay.TotalSeconds * 2, 30));
                } while (st.StatusCode == "IP");

                if (st.StatusCode == "ER") throw new InvalidOperationException($"Part {i + 1} rejected by GSTN (ref {refId})");
                if (st.ErrorReport != null) errors.AddRange(st.ErrorReport);
                await onPartSaved(i + 1, refId); // persist part status => job is resumable
            }
            return errors;
        }

        /// <summary>Splits B2B invoices into parts of at most chunkSize invoices; summary tables go on the last part.</summary>
        public static List<Gstr1Payload> Chunk(Gstr1Payload full, int chunkSize)
        {
            var parts = new List<Gstr1Payload>();
            var current = new List<B2bParty>();
            int count = 0;
            void Flush()
            {
                if (current.Count == 0) return;
                parts.Add(new Gstr1Payload { Gstin = full.Gstin, Fp = full.Fp, B2b = current });
                current = new List<B2bParty>();
                count = 0;
            }
            foreach (var party in full.B2b ?? new List<B2bParty>())
            {
                int offset = 0;
                while (offset < party.Inv.Count)
                {
                    int take = Math.Min(chunkSize - count, party.Inv.Count - offset);
                    current.Add(new B2bParty(party.Ctin, party.Inv.GetRange(offset, take)));
                    count += take;
                    offset += take;
                    if (count >= chunkSize) Flush();
                }
            }
            Flush();
            if (parts.Count == 0) parts.Add(new Gstr1Payload { Gstin = full.Gstin, Fp = full.Fp });
            var last = parts[^1];
            last.B2cs = full.B2cs; last.Hsn = full.Hsn; last.DocIssue = full.DocIssue;
            return parts;
        }
    }
}
