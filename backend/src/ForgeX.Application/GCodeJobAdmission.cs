namespace ForgeX.Application;

public sealed record GCodeJobAdmissionOptions(
    int MaxActivePerOwner = 4,
    int MaxActivePerTenant = 16)
{
    public GCodeJobAdmissionOptions Validate()
    {
        if (MaxActivePerOwner is < 1 or > 1024)
        {
            throw new InvalidOperationException("GCodeJobs:Admission:MaxActivePerOwner must be between 1 and 1024.");
        }
        if (MaxActivePerTenant is < 1 or > 4096)
        {
            throw new InvalidOperationException("GCodeJobs:Admission:MaxActivePerTenant must be between 1 and 4096.");
        }
        if (MaxActivePerTenant < MaxActivePerOwner)
        {
            throw new InvalidOperationException("GCodeJobs:Admission:MaxActivePerTenant must be at least MaxActivePerOwner.");
        }
        return this;
    }

    public static GCodeJobAdmissionOptions Unbounded { get; } = new(int.MaxValue, int.MaxValue);
}
