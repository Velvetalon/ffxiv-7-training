using Lumina.Excel;

[Sheet("CharaMakeCustomize", 0xC30E9B73)]
public readonly struct CharaMakeCustomizeRow(ExcelPage page, uint offset, uint row) : IExcelRow<CharaMakeCustomizeRow>
{
    public uint RowId => row;
    public byte FeatureId => page.ReadUInt8(offset + 14);
    public byte FaceType => page.ReadUInt8(offset + 15);
    public bool IsPurchasable => page.ReadPackedBool(offset + 16, 0);
    static CharaMakeCustomizeRow IExcelRow<CharaMakeCustomizeRow>.Create(ExcelPage page, uint offset, uint row) => new(page, offset, row);
}
